'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { formatMoney, centsToDollars } from '@meritbooks/shared';
import { useQuery } from '@/hooks';
import { api } from '@/lib/api-client';
import { addToast } from '@/hooks/use-toast';
import {
  UploadCloud, FileText, Loader2, X, Trash2, Sparkles, AlertTriangle, CheckCircle2, Info, CreditCard, CopyCheck,
} from 'lucide-react';

type StatementAccountType = 'CHECKING' | 'SAVINGS' | 'CREDIT_CARD' | 'LINE_OF_CREDIT';

interface AccountOption {
  id: string;
  label: string;
  mask: string | null;
  type: StatementAccountType;
  locationName: string;
  plaidLinked: boolean;
}

interface BalanceTie {
  checkable: boolean;
  openingCents: number | null;
  closingCents: number | null;
  sumCents: number;
  expectedSumCents: number | null;
  differenceCents: number | null;
  tied: boolean;
  toleranceCents: number;
}

interface ProposedLine {
  _id: string;
  transaction_date: string | null;
  description: string;
  amount_cents: number | null;
  direction: 'money_in' | 'money_out';
  running_balance_cents: number | null;
  confidence: number;
  lowConfidence: boolean;
  duplicate: boolean;
  dedupeKey: string;
}

interface ParseResponse {
  account: { id: string; label: string; mask: string | null; type: StatementAccountType };
  statement: {
    accountHeader: { name: string | null; last4: string | null; type: StatementAccountType | null };
    periodStart: string | null;
    periodEnd: string | null;
    openingCents: number | null;
    closingCents: number | null;
    balanceTie: BalanceTie;
    documentNote: string | null;
    transactions: ProposedLine[];
  };
  meta: { fileName: string; model: string; decisionId: string | null; lineCount: number; duplicateCount: number };
}

interface Row extends ProposedLine {
  include: boolean;
}

const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];

function toRows(lines: ProposedLine[]): Row[] {
  // Default: exclude anything flagged as an existing duplicate (don't re-import).
  return lines.map((l) => ({ ...l, include: !l.duplicate }));
}

export function StatementImport({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: (count: number) => void;
}) {
  const [phase, setPhase] = useState<'select' | 'parsing' | 'review' | 'confirming'>('select');
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accountId, setAccountId] = useState<string>('');
  const [parsed, setParsed] = useState<ParseResponse | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  const { data: acctData, isLoading: acctLoading } = useQuery<{ accounts: AccountOption[] }>(
    '/api/bank-feed/import-statement',
  );

  // Close on Escape (skip while actively parsing/confirming so a keystroke can't
  // abandon in-flight work).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && phase !== 'parsing' && phase !== 'confirming') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, phase]);
  const accounts = acctData?.accounts ?? [];
  const manualAccounts = accounts.filter((a) => !a.plaidLinked);
  const selected = accounts.find((a) => a.id === accountId) ?? null;
  const isPlaid = selected?.plaidLinked ?? false;
  const canUpload = !!selected && !isPlaid;

  const parse = useCallback(
    async (file: File) => {
      setError(null);
      if (!accountId) {
        setError('Choose a target account first.');
        return;
      }
      if (!ALLOWED.includes(file.type)) {
        setError('Unsupported file type. Upload a PDF, JPEG, PNG, or WebP.');
        return;
      }
      if (file.size > 15 * 1024 * 1024) {
        setError('File too large. Maximum 15MB.');
        return;
      }
      setPhase('parsing');
      const formData = new FormData();
      formData.append('file', file);
      formData.append('bank_account_id', accountId);
      try {
        const res = await fetch('/api/bank-feed/import-statement', { method: 'POST', body: formData });
        const body = (await res.json()) as ParseResponse | { error: string };
        if (!res.ok || 'error' in body) {
          setError('error' in body ? body.error : 'Failed to parse statement');
          setPhase('select');
          return;
        }
        setParsed(body);
        setRows(toRows(body.statement.transactions));
        setPhase('review');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Network error');
        setPhase('select');
      }
    },
    [accountId],
  );

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (!canUpload) return;
    const file = e.dataTransfer.files?.[0];
    if (file) void parse(file);
  }

  const setRow = <K extends keyof Row>(id: string, k: K, v: Row[K]) =>
    setRows((rs) => rs.map((r) => (r._id === id ? { ...r, [k]: v } : r)));

  function removeRow(id: string) {
    setRows((rs) => rs.filter((r) => r._id !== id));
  }

  const included = rows.filter((r) => r.include);
  const includedCount = included.length;
  const duplicateCount = rows.filter((r) => r.duplicate).length;

  // Live balance tie: opening/closing are fixed; the sum reflects edited amounts.
  const expectedSum = parsed?.statement.balanceTie.expectedSumCents ?? null;
  const liveSum = useMemo(() => included.reduce((acc, r) => acc + (r.amount_cents ?? 0), 0), [included]);
  const checkable = parsed?.statement.balanceTie.checkable ?? false;
  const liveDiff = expectedSum == null ? null : liveSum - expectedSum;
  const tied = liveDiff == null ? false : Math.abs(liveDiff) <= (parsed?.statement.balanceTie.toleranceCents ?? 0);

  function excludeDuplicates() {
    setRows((rs) => rs.map((r) => (r.duplicate ? { ...r, include: false } : r)));
  }

  async function confirmImport() {
    if (!parsed) return;
    const bad = included.filter((r) => !r.transaction_date || r.amount_cents == null || !r.description.trim());
    if (bad.length > 0) {
      addToast('error', 'Each included line needs a date, a description, and a non-zero amount.');
      return;
    }
    if (includedCount === 0) {
      addToast('error', 'Select at least one line to import.');
      return;
    }
    setPhase('confirming');
    const payload = {
      bank_account_id: parsed.account.id,
      decision_id: parsed.meta.decisionId,
      transactions: included.map((r) => ({
        transaction_date: r.transaction_date as string,
        description: r.description.trim(),
        amount_cents: r.amount_cents as number,
      })),
    };
    const res = await api.post<{ ok: true; inserted: number; skipped: number; total: number }>(
      '/api/bank-feed/import-statement/confirm',
      payload,
    );
    if (res.error || !res.data) {
      addToast('error', res.error?.error ?? 'Import failed');
      setPhase('review');
      return;
    }
    const { inserted, skipped } = res.data;
    addToast(
      'success',
      `${inserted} transaction${inserted === 1 ? '' : 's'} imported${skipped > 0 ? ` · ${skipped} duplicate${skipped === 1 ? '' : 's'} skipped` : ''}`,
    );
    onImported(inserted);
  }

  const inputCls =
    'w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded-md text-xs text-white focus:border-emerald-500 focus:outline-none';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="statement-import-title"
        className="card w-full max-w-5xl max-h-[92vh] overflow-y-auto p-6"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Sparkles size={18} className="text-indigo-400" />
            <div>
              <h2 id="statement-import-title" className="text-lg font-semibold text-white">Import statement (PDF)</h2>
              <p className="text-[11px] text-slate-500">
                For manual accounts without a Plaid feed. Drop a bank or credit-card statement — AI extracts the
                transactions; you review and confirm. Nothing is imported until you confirm.
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-800 text-slate-500 hover:text-white" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {error}
          </div>
        )}

        {/* ── Select account + upload ─────────────────────────────────── */}
        {(phase === 'select' || phase === 'parsing') && (
          <>
            <div className="mb-4">
              <label htmlFor="statement-target-account" className="block text-[11px] text-slate-500 mb-1">Target account</label>
              {acctLoading ? (
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <Loader2 size={13} className="animate-spin" /> Loading accounts…
                </div>
              ) : accounts.length === 0 ? (
                <div className="text-xs text-slate-500">No bank accounts found. Add a bank account first.</div>
              ) : (
                <select
                  id="statement-target-account"
                  className={clsx(inputCls, 'max-w-md')}
                  value={accountId}
                  onChange={(e) => { setAccountId(e.target.value); setError(null); }}
                  disabled={phase === 'parsing'}
                >
                  <option value="">Select an account…</option>
                  {manualAccounts.length > 0 && (
                    <optgroup label="Manual (importable)">
                      {manualAccounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.label}{a.mask ? ` ••${a.mask}` : ''} · {a.locationName}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {accounts.some((a) => a.plaidLinked) && (
                    <optgroup label="Plaid-linked (live feed — not importable)">
                      {accounts.filter((a) => a.plaidLinked).map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.label}{a.mask ? ` ••${a.mask}` : ''} · {a.locationName}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              )}
            </div>

            {isPlaid && (
              <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                <CreditCard size={14} className="mt-0.5 shrink-0" />
                This account is linked to Plaid — its live feed is the source of truth. Statement import is only for
                manual (non-Plaid) accounts.
              </div>
            )}

            <div
              onDragOver={(e) => { e.preventDefault(); if (canUpload) setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              onClick={() => canUpload && phase === 'select' && fileInput.current?.click()}
              className={clsx(
                'flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-16 text-center transition-colors',
                phase === 'parsing'
                  ? 'border-indigo-500/40 bg-indigo-500/5 cursor-default'
                  : !canUpload
                    ? 'border-slate-800 bg-slate-900/40 opacity-60 cursor-not-allowed'
                    : dragOver
                      ? 'border-emerald-500 bg-emerald-500/5 cursor-pointer'
                      : 'border-slate-700 hover:border-slate-600 cursor-pointer',
              )}
            >
              <input
                ref={fileInput}
                type="file"
                accept=".pdf,image/*"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void parse(f); e.target.value = ''; }}
              />
              {phase === 'parsing' ? (
                <>
                  <Loader2 className="w-9 h-9 text-indigo-400 animate-spin mb-3" />
                  <p className="text-sm text-slate-300">Reading the statement and extracting transactions…</p>
                  <p className="text-[11px] text-slate-500 mt-1">This can take 15-30 seconds for a long statement.</p>
                </>
              ) : (
                <>
                  <UploadCloud className="w-10 h-10 text-slate-500 mb-3" />
                  <p className="text-sm text-slate-200 font-medium">
                    {canUpload ? 'Drop a bank / credit-card statement here' : 'Select an importable account to continue'}
                  </p>
                  <p className="text-[11px] text-slate-500 mt-1">or click to browse · PDF, PNG, JPEG · up to 15MB</p>
                </>
              )}
            </div>
          </>
        )}

        {/* ── Review ──────────────────────────────────────────────────── */}
        {(phase === 'review' || phase === 'confirming') && parsed && (
          <>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-[11px] text-slate-400">
                <FileText size={13} className="text-indigo-400" />
                <span className="truncate max-w-[220px]">{parsed.meta.fileName}</span>
                <span className="text-slate-600">·</span>
                <span>{parsed.account.label}{parsed.account.mask ? ` ••${parsed.account.mask}` : ''}</span>
                {(parsed.statement.periodStart || parsed.statement.periodEnd) && (
                  <>
                    <span className="text-slate-600">·</span>
                    <span>{parsed.statement.periodStart ?? '?'} → {parsed.statement.periodEnd ?? '?'}</span>
                  </>
                )}
              </div>
              <div className="text-[11px] text-slate-500">
                {includedCount} of {rows.length} line{rows.length === 1 ? '' : 's'} selected
              </div>
            </div>

            {/* Balance tie-out banner */}
            {checkable ? (
              <div
                className={clsx(
                  'mb-3 flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-xs',
                  tied
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                    : 'border-amber-500/30 bg-amber-500/10 text-amber-300',
                )}
              >
                <div className="flex items-center gap-2">
                  {tied ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
                  <span>
                    {tied
                      ? 'Balances tie out: opening + selected lines = closing.'
                      : 'Balances do not tie — the selected lines do not foot to the statement change.'}
                  </span>
                </div>
                <div className="flex items-center gap-3 font-mono">
                  <span>Open {formatMoney(parsed.statement.openingCents ?? 0)}</span>
                  <span>Close {formatMoney(parsed.statement.closingCents ?? 0)}</span>
                  {!tied && liveDiff != null && <span className="font-semibold">Off by {formatMoney(Math.abs(liveDiff))}</span>}
                </div>
              </div>
            ) : (
              <div className="mb-3 flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-[11px] text-slate-400">
                <Info size={13} className="shrink-0 text-slate-500" />
                The statement did not state both an opening and closing balance, so a tie-out check is not possible.
                Review the lines carefully.
              </div>
            )}

            {parsed.statement.documentNote && (
              <div className="mb-3 flex items-start gap-2 rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-[11px] text-slate-400">
                <Info size={13} className="mt-0.5 shrink-0 text-slate-500" /> {parsed.statement.documentNote}
              </div>
            )}

            {duplicateCount > 0 && (
              <div className="mb-3 flex items-center justify-between gap-2 rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-[11px] text-blue-300">
                <span className="flex items-center gap-2">
                  <CopyCheck size={13} /> {duplicateCount} line{duplicateCount === 1 ? '' : 's'} already exist in this account (matched by date, amount &amp; description).
                </span>
                <button onClick={excludeDuplicates} className="underline hover:text-blue-200">Exclude all duplicates</button>
              </div>
            )}

            {rows.length === 0 ? (
              <div className="rounded-xl border border-slate-800 bg-slate-900/40 px-6 py-12 text-center">
                <FileText className="w-8 h-8 mx-auto text-slate-600 mb-2" />
                <p className="text-sm text-slate-300">No transactions were detected in this statement.</p>
              </div>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-slate-800">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-800 text-left text-[10px] uppercase tracking-wide text-slate-500">
                      <th className="px-2 py-2 w-8"></th>
                      <th className="px-2 py-2 w-32">Date</th>
                      <th className="px-2 py-2">Description</th>
                      <th className="px-2 py-2 w-36 text-right">Amount</th>
                      <th className="px-2 py-2 w-16"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr
                        key={r._id}
                        className={clsx(
                          'border-b border-slate-900/70',
                          !r.include && 'opacity-40',
                          r.lowConfidence && 'bg-amber-500/[0.04]',
                        )}
                      >
                        <td className="px-2 py-1.5 align-middle">
                          <input
                            type="checkbox"
                            checked={r.include}
                            onChange={(e) => setRow(r._id, 'include', e.target.checked)}
                            className="accent-emerald-500"
                            aria-label="Include line"
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <input
                            type="date"
                            className={clsx(inputCls, r.transaction_date == null && 'border-amber-500/60')}
                            value={r.transaction_date ?? ''}
                            onChange={(e) => setRow(r._id, 'transaction_date', e.target.value || null)}
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <div className="flex items-center gap-1.5">
                            <input
                              className={inputCls}
                              value={r.description}
                              onChange={(e) => setRow(r._id, 'description', e.target.value)}
                              placeholder="Description"
                            />
                            {r.duplicate && (
                              <span className="shrink-0 rounded bg-blue-500/15 px-1.5 py-0.5 text-[9px] font-medium text-blue-300" title="Already exists in this account">
                                DUP
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-2 py-1.5">
                          <input
                            type="number"
                            step="0.01"
                            className={clsx(
                              inputCls,
                              'text-right font-mono',
                              r.amount_cents == null && 'border-amber-500/60',
                              (r.amount_cents ?? 0) < 0 ? 'text-red-300' : 'text-emerald-300',
                            )}
                            value={r.amount_cents == null ? '' : centsToDollars(r.amount_cents)}
                            onChange={(e) =>
                              setRow(r._id, 'amount_cents', e.target.value === '' ? null : Math.round(Number(e.target.value) * 100))
                            }
                            placeholder="0.00"
                            title="Negative = money out (debit / charge); positive = money in"
                          />
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          <button
                            onClick={() => removeRow(r._id)}
                            className="p-1 rounded text-slate-500 hover:text-red-400 hover:bg-slate-800"
                            aria-label="Remove line"
                            title="Remove"
                          >
                            <Trash2 size={13} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="mt-5 flex items-center justify-between">
              <p className="text-[11px] text-slate-600 max-w-md">
                Imported lines land in the bank feed as PENDING and flow through the same AI categorization and
                reconciliation as a live feed. Negative = money out (debit / card charge); positive = money in.
              </p>
              <div className="flex items-center gap-2">
                <button onClick={onClose} className="px-4 py-2 text-sm text-slate-400 hover:text-white">Cancel</button>
                <button
                  onClick={confirmImport}
                  disabled={phase === 'confirming' || includedCount === 0}
                  className="px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg disabled:opacity-50 flex items-center gap-2"
                >
                  {phase === 'confirming' && <Loader2 size={14} className="animate-spin" />}
                  Import {includedCount} transaction{includedCount === 1 ? '' : 's'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
