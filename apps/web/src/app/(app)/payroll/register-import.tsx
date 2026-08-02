'use client';

/**
 * Import payroll register: DROP-AND-PARSE a payroll register into a payroll JE.
 *
 * This is the MANUAL-IMPORT path for tenants NOT on the embedded provider. Flow:
 * drop the payroll register PDF from an outside processor (ADP/Paychex/Gusto/QBO/
 * spreadsheet) → the AI (via the metered gateway) extracts the period totals and
 * PROPOSES a BALANCED payroll journal entry, each line addressed by role with a
 * suggested account → the human picks a company, reviews/adjusts every account +
 * amount, and confirms → the balanced entry posts to the GL.
 *
 * The model never writes anything: this UI only ever POSTs (a) the file to parse
 * and (b) an explicit, human-confirmed, balanced entry. Running payroll inside the
 * product (the embedded run wizard) stays the alternative for provider tenants.
 */

import { useState, useRef, useEffect, useMemo } from 'react';
import {
  UploadCloud, Loader2, X, FileText, Sparkles, AlertTriangle, CheckCircle2, Info, ChevronDown, Search, Scale,
} from 'lucide-react';
import { clsx } from 'clsx';
import { formatMoney, dollarsToCents, centsToDollars } from '@meritbooks/shared';
import { useQuery, addToast } from '@/hooks';
import { api } from '@/lib/api-client';

// ── Types mirroring the parse API ────────────────────────────────────────────
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
interface ParseResponse {
  register: {
    payDate: string | null;
    periodStart: string | null;
    periodEnd: string | null;
    employeeCount: number | null;
    grossCents: number;
    netCents: number;
    lowConfidenceFields: string[];
  };
  lines: ProposedLine[];
  balance: {
    totalDebitCents: number;
    totalCreditCents: number;
    balanced: boolean;
    imbalanceCents: number;
    registerFoots: boolean;
    footingDeltaCents: number;
  };
  unresolvedRoles: string[];
  meta: { fileName: string; model: string; decisionId: string | null; documentNote: string | null; extractionMs: number };
}

interface LocationOption { id: string; name: string; short_code: string }
interface AccountOption { id: string; accountNumber: string; name: string; accountType: string; isActive: boolean; approvalStatus: string }

const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPT = '.pdf,image/png,image/jpeg,image/webp';
const todayIso = () => new Date().toISOString().slice(0, 10);
const centsToInput = (c: number) => centsToDollars(c).toFixed(2);
const inputToCents = (s: string) => dollarsToCents(Number(String(s).replace(/[$,\s]/g, '')) || 0);

// ── Editable line-draft state ────────────────────────────────────────────────
interface LineDraft {
  key: string;
  roleKey: string;
  side: 'DR' | 'CR';
  label: string;
  amountInput: string;
  accountId: string;
  degraded: boolean;
  unresolved: boolean;
  suggestedAccountId: string | null;
}

// ── Inline account picker (searches this company's approved COA) ─────────────
function AccountPicker({
  value, accounts, onChange, placeholder, invalid,
}: {
  value: string;
  accounts: AccountOption[];
  onChange: (id: string) => void;
  placeholder: string;
  invalid: boolean;
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
  const filtered = q
    ? accounts.filter((a) => a.accountNumber.toLowerCase().includes(q) || a.name.toLowerCase().includes(q))
    : accounts;

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

// ── Main modal ───────────────────────────────────────────────────────────────
export function ImportRegister({ open, onClose, onPosted }: { open: boolean; onClose: () => void; onPosted: () => void }) {
  const [phase, setPhase] = useState<'idle' | 'parsing' | 'review' | 'error' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Parse result / editable drafts
  const [drafts, setDrafts] = useState<LineDraft[]>([]);
  const [locationId, setLocationId] = useState('');
  const [payDate, setPayDate] = useState('');
  const [memo, setMemo] = useState('');
  const [decisionId, setDecisionId] = useState<string | null>(null);
  const [docNote, setDocNote] = useState<string | null>(null);
  const [unresolvedRoles, setUnresolvedRoles] = useState<string[]>([]);
  const [registerFoots, setRegisterFoots] = useState(true);
  const [footingDelta, setFootingDelta] = useState(0);
  const [postedEntryNumber, setPostedEntryNumber] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Accounts for the chosen company
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [loadingAccts, setLoadingAccts] = useState(false);

  const { data: locData } = useQuery<LocationOption[]>(open ? '/api/locations' : null);
  const locations = useMemo(() => locData ?? [], [locData]);

  useEffect(() => {
    if (!open) {
      setPhase('idle'); setError(null); setFileName(null); setDrafts([]); setLocationId(''); setPayDate('');
      setMemo(''); setDecisionId(null); setDocNote(null); setUnresolvedRoles([]); setRegisterFoots(true);
      setFootingDelta(0); setPostedEntryNumber(null); setSaving(false); setAccounts([]);
    }
  }, [open]);

  // Load this company's approved chart when a company is chosen; default each line's
  // account to its suggested account (by role) when that account exists here.
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
            ? { ...ln, accountId: ln.suggestedAccountId }
            : ln
        )));
      })
      .catch(() => alive && setAccounts([]))
      .finally(() => alive && setLoadingAccts(false));
    return () => { alive = false; };
  }, [locationId]);

  const usableAccounts = useMemo(() => accounts.filter((a) => a.isActive && a.approvalStatus === 'APPROVED'), [accounts]);

  if (!open) return null;

  const handleFile = async (file: File) => {
    setError(null);
    if (file.size > MAX_BYTES) { setError('File too large. Maximum 10MB.'); setPhase('error'); return; }
    setFileName(file.name);
    setPhase('parsing');

    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/payroll/import-register', { method: 'POST', body: form });
    let body: ParseResponse & { error?: string };
    try { body = await res.json(); } catch { setError('The server returned an unreadable response.'); setPhase('error'); return; }
    if (!res.ok) { setError(body.error || 'Failed to parse the payroll register.'); setPhase('error'); return; }

    setDecisionId(body.meta?.decisionId ?? null);
    setDocNote(body.meta?.documentNote ?? null);
    setUnresolvedRoles(body.unresolvedRoles ?? []);
    setRegisterFoots(body.balance?.registerFoots ?? true);
    setFootingDelta(body.balance?.footingDeltaCents ?? 0);
    setPayDate(body.register?.payDate ?? todayIso());
    setMemo(`Payroll register — pay date ${body.register?.payDate ?? ''}`.trim());
    setDrafts((body.lines ?? []).map((l, i) => ({
      key: `${i}-${l.roleKey}-${l.side}`,
      roleKey: l.roleKey,
      side: l.side,
      label: l.label,
      amountInput: centsToInput(l.cents),
      accountId: '',
      degraded: l.degraded,
      unresolved: l.unresolved,
      suggestedAccountId: l.suggestedAccountId,
    })));
    setPhase('review');
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  };

  const patchLine = (key: string, patch: Partial<LineDraft>) =>
    setDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)));

  // Live balance from the (editable) drafts.
  const totalDebits = drafts.filter((d) => d.side === 'DR').reduce((s, d) => s + inputToCents(d.amountInput), 0);
  const totalCredits = drafts.filter((d) => d.side === 'CR').reduce((s, d) => s + inputToCents(d.amountInput), 0);
  const imbalance = totalDebits - totalCredits;
  const balanced = imbalance === 0 && totalDebits > 0;
  const allAccountsPicked = drafts.every((d) => inputToCents(d.amountInput) === 0 || !!d.accountId);
  const canPost = !saving && balanced && allAccountsPicked && !!locationId && !!payDate && drafts.length >= 2;

  const confirmPost = async () => {
    setSaving(true);
    const lines = drafts
      .filter((d) => inputToCents(d.amountInput) > 0)
      .map((d) => ({
        accountId: d.accountId,
        debitCents: d.side === 'DR' ? inputToCents(d.amountInput) : 0,
        creditCents: d.side === 'CR' ? inputToCents(d.amountInput) : 0,
        memo: d.label,
      }));
    const res = await api.post<{ ok: boolean; entryNumber: string; alreadyPosted: boolean }>(
      '/api/payroll/import-register/confirm',
      { locationId, payDate, memo, lines, decisionId },
    );
    if (res.error) { setSaving(false); addToast('error', res.error.error); return; }
    setPostedEntryNumber(res.data?.entryNumber ?? null);
    setSaving(false);
    setPhase('done');
    addToast('success', res.data?.alreadyPosted ? 'Payroll register already posted' : 'Payroll register posted to the ledger');
    onPosted();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 backdrop-blur-sm p-4 sm:p-8">
      <div className="w-full max-w-3xl bg-surface-900 border border-slate-800 rounded-2xl shadow-2xl my-4">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <div>
            <h2 className="text-sm font-semibold text-white flex items-center gap-2"><UploadCloud size={16} className="text-emerald-400" /> Import payroll register</h2>
            <p className="text-2xs text-slate-500 mt-0.5">For payroll run OUTSIDE MeritBooks — drop the processor&apos;s register and AI proposes a balanced payroll entry to confirm.</p>
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
                <UploadCloud size={28} className="mx-auto text-slate-500 mb-3" />
                <p className="text-sm text-slate-300">Drop a payroll register here, or <span className="text-emerald-400">browse</span></p>
                <p className="text-2xs text-slate-500 mt-1">PDF, PNG, JPEG, or WebP · up to 10MB</p>
              </div>
              <input ref={inputRef} type="file" accept={ACCEPT} className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); e.target.value = ''; }} />
              <div className="flex items-start gap-2 text-2xs text-slate-500">
                <Info size={12} className="mt-0.5 shrink-0" />
                <span>The AI proposes — it never posts. Nothing is written until you confirm the balanced entry. On the embedded provider instead? Use <span className="text-slate-300">Run payroll</span>.</span>
              </div>
            </>
          )}

          {/* Parsing */}
          {phase === 'parsing' && (
            <div className="py-16 text-center">
              <Loader2 size={28} className="mx-auto text-emerald-400 animate-spin mb-3" />
              <p className="text-sm text-slate-300">Reading {fileName ?? 'register'}…</p>
              <p className="text-2xs text-slate-500 mt-1">Extracting the period totals and proposing a balanced payroll entry.</p>
            </div>
          )}

          {/* Error */}
          {phase === 'error' && (
            <div className="py-12 text-center">
              <AlertTriangle size={24} className="mx-auto text-red-400 mb-2" />
              <p className="text-sm text-red-400">{error}</p>
              <button onClick={() => { setPhase('idle'); setError(null); }} className="mt-3 px-3 py-1.5 border border-slate-700 rounded-lg text-xs text-slate-300 hover:bg-slate-800">Try another file</button>
            </div>
          )}

          {/* Done */}
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

          {/* Review */}
          {phase === 'review' && (
            <div className="space-y-4">
              {fileName && (
                <div className="flex items-center gap-2 text-2xs text-slate-500">
                  <FileText size={12} /> <span className="text-slate-400">{fileName}</span>
                  <Sparkles size={11} className="text-indigo-400" /> <span className="text-indigo-300/80">AI-proposed</span>
                </div>
              )}
              {docNote && (
                <div className="flex items-start gap-2 rounded-lg bg-slate-800/40 px-3 py-2 text-2xs text-slate-400">
                  <Info size={12} className="mt-0.5 shrink-0 text-slate-500" /> {docNote}
                </div>
              )}
              {!registerFoots && (
                <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-2">
                  <AlertTriangle size={13} className="text-amber-400 mt-0.5 shrink-0" />
                  <p className="text-2xs text-amber-200/90">
                    The register does not foot — gross minus withholdings and deductions is off from net pay by
                    {' '}<span className="font-mono">{formatMoney(Math.abs(footingDelta))}</span>. Check the extracted amounts before posting.
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

              {/* Header inputs */}
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
                balanced ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-300' : 'bg-red-500/10 border border-red-500/30 text-red-300')}>
                <Scale size={14} className="shrink-0" />
                {balanced
                  ? <span>Balanced — debits equal credits at <span className="font-mono">{formatMoney(totalDebits)}</span>.</span>
                  : <span>Out of balance by <span className="font-mono">{formatMoney(Math.abs(imbalance))}</span> — fix the amounts before posting.</span>}
              </div>

              {/* Actions */}
              <div className="flex items-center justify-between pt-1">
                <button onClick={() => { setPhase('idle'); setDrafts([]); }} className="text-2xs text-slate-500 hover:text-slate-300">Upload a different register</button>
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
