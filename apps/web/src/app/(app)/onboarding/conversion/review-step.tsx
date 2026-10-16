'use client';

import { useMemo, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, Check, CheckCheck, FileText, Filter, Info, ListChecks,
  Loader2, Lock, Save, Scale, ShieldCheck, Sparkles, Undo2,
} from 'lucide-react';
import { formatMoney } from '@meritbooks/shared';
import {
  matchStrength,
  formatLongDate,
  STRONG_MATCH_THRESHOLD,
  type AccountMapping,
  type BalanceCheck,
  type BalanceSheetCheck,
  type MatchStrength,
  type OpeningBalanceLine,
} from '@/lib/onboarding/conversion';
import { NONE, type CoaAccount, type SessionView } from './types';

/**
 * STEP 3 — "Check the numbers match" (the tie-out).
 *
 * FPB B8: every blocker the post route enforces (base TB + subledger→control ties)
 * is listed here BEFORE the confirm button, in dollars; the button stays disabled
 * with the reasons shown. Mapping edits are staged locally and saved in ONE request.
 */

interface SourceRow { sourceAccount: string; sourceName: string | null; debitCents: number; creditCents: number }

export interface ReviewStepProps {
  session: SessionView;
  coa: CoaAccount[];
  busy: boolean;
  onBack: () => void;
  /** Save staged mapping changes (and/or accept strong matches) in one request. */
  onSaveMapping: (changes: Record<string, string | null>, acceptStrong: boolean) => Promise<boolean>;
  onTieOut: (v: boolean) => void;
  onPost: () => void;
  onAckPl: (v: boolean) => void;
}

export function ReviewStep({ session, coa, busy, onBack, onSaveMapping, onTieOut, onPost, onAckPl }: ReviewStepProps) {
  const [pending, setPending] = useState<Record<string, string | null>>({});
  const [onlyToCheck, setOnlyToCheck] = useState(false);

  const sourceRows: SourceRow[] = useMemo(() => {
    const map = new Map<string, SourceRow>();
    for (const l of session.sourceLines) {
      const cur = map.get(l.sourceAccount) ?? { sourceAccount: l.sourceAccount, sourceName: l.sourceName, debitCents: 0, creditCents: 0 };
      cur.debitCents += l.debitCents || 0;
      cur.creditCents += l.creditCents || 0;
      if (!cur.sourceName && l.sourceName) cur.sourceName = l.sourceName;
      map.set(l.sourceAccount, cur);
    }
    return [...map.values()]
      .filter((r) => r.debitCents !== 0 || r.creditCents !== 0)
      .sort((a, b) => a.sourceAccount.localeCompare(b.sourceAccount));
  }, [session.sourceLines]);

  const strengthOf = (src: string): MatchStrength => matchStrength(session.mapping[src]);
  const strongCount = sourceRows.filter((r) => strengthOf(r.sourceAccount) === 'strong').length;
  const toCheckCount = sourceRows.filter((r) => ['check', 'missing'].includes(strengthOf(r.sourceAccount))).length;
  const pendingCount = Object.keys(pending).length;
  const visibleRows = onlyToCheck
    ? sourceRows.filter((r) => ['check', 'missing'].includes(strengthOf(r.sourceAccount)) || r.sourceAccount in pending)
    : sourceRows;

  const blockers = session.blockers ?? [];
  const locked = session.cutover?.state === 'locked';
  const canConfirm = blockers.length === 0 && pendingCount === 0 && !session.tiedOut && !session.posted;
  const bal = session.balance;
  const companyLabel = session.companyName ?? session.companyShortCode;

  const stage = (src: string, value: string) => {
    const target = value === NONE ? null : value;
    const current = session.mapping[src]?.targetAccountNumber ?? null;
    setPending((p) => {
      const next = { ...p };
      if (target === current && session.mapping[src]?.source === 'human') delete next[src];
      else next[src] = target;
      return next;
    });
  };

  const save = async (acceptStrong: boolean) => {
    const ok = await onSaveMapping(pending, acceptStrong);
    if (ok) setPending({});
  };

  return (
    <div>
      <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-300 mb-4 transition-colors">
        <ArrowLeft size={13} /> Back to columns
      </button>

      <p className="text-sm text-slate-300 mb-4">
        <span className="font-medium text-white">{companyLabel}</span> — balances as of{' '}
        <span className="font-mono text-slate-200">{formatLongDate(session.asOfDate)}</span>
        {session.takeoverDate && <> · MeritBooks takes over on <span className="text-slate-200">{formatLongDate(session.takeoverDate)}</span></>}
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        <SummaryStat label="Accounts with a balance" value={String(session.openingBalances.length)} tone="muted" />
        <SummaryStat label="Total debits" value={formatMoney(bal.totalDebitCents)} tone="ok" />
        <SummaryStat label="Total credits" value={formatMoney(bal.totalCreditCents)} tone="ok" />
      </div>

      <BalanceBanner balance={bal} />

      {/* Cutover month state (B1) — a locked month is flagged now, not at post time */}
      {session.cutover?.message && (
        <div className={`mt-3 flex items-start gap-2 rounded-lg border px-4 py-3 text-sm ${locked ? 'border-rose-500/30 bg-rose-500/10 text-rose-200' : 'border-blue-500/25 bg-blue-500/5 text-blue-200'}`}>
          {locked ? <Lock size={15} className="mt-0.5 shrink-0" /> : <Info size={15} className="mt-0.5 shrink-0" />}
          <span>{session.cutover.message}</span>
        </div>
      )}

      {/* EVERYTHING the go-live gate checks (FPB B8) */}
      <div className="mt-4 rounded-xl border border-slate-800 bg-surface-900 px-4 py-3" aria-live="polite">
        <div className="flex items-center gap-2 mb-2">
          <ListChecks size={15} className="text-brand-400" />
          <p className="text-sm font-semibold text-white">What&apos;s left before you can confirm</p>
        </div>
        {blockers.length === 0 ? (
          <p className="text-sm text-emerald-300 flex items-center gap-2"><Check size={15} /> Nothing — every check passes.</p>
        ) : (
          <ul className="space-y-1.5">
            {blockers.map((b, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-amber-200/90">
                <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-400" /> <span>{b}</span>
              </li>
            ))}
          </ul>
        )}
        {(session.subledgerTies?.length ?? 0) > 0 && <SubledgerTies ties={session.subledgerTies ?? []} />}
      </div>

      <div className="mt-3 rounded-xl border border-slate-800 bg-surface-900 px-4 py-3">
        <p className="text-2xs font-semibold uppercase tracking-wider text-slate-500 mb-1">Your file vs what we&apos;ll post</p>
        <p className="text-2xs text-slate-500 mb-2">These should match. If they don&apos;t, an account in your file still needs a MeritBooks account.</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-1 text-sm">
          <ReconLine label="Debits in your file" value={session.sourceTotals.debitCents} />
          <ReconLine label="Debits we'll post" value={bal.totalDebitCents} />
          <ReconLine label="Credits in your file" value={session.sourceTotals.creditCents} />
          <ReconLine label="Credits we'll post" value={bal.totalCreditCents} />
        </div>
      </div>

      {(session.intake?.excludedCount ?? 0) > 0 && (
        <details className="mt-3 rounded-xl border border-slate-800 bg-surface-900/60 px-4 py-3">
          <summary className="flex cursor-pointer items-center gap-2 text-2xs font-semibold uppercase tracking-wider text-slate-500">
            <Filter size={13} className="text-slate-400" />
            {session.intake?.excludedCount} row{session.intake?.excludedCount === 1 ? '' : 's'} skipped as totals or headings
            {session.intake?.zeroRows ? ` · ${session.intake.zeroRows} zero-balance row${session.intake.zeroRows === 1 ? '' : 's'}` : ''}
          </summary>
          <ul className="mt-2 space-y-0.5 max-h-28 overflow-y-auto">
            {(session.intake?.excluded ?? []).slice(0, 30).map((e, i) => (
              <li key={i} className="text-2xs text-slate-500"><span className="font-mono text-slate-600">Row {e.row}</span> — {e.reason}</li>
            ))}
          </ul>
          <p className="text-2xs text-slate-600 mt-1.5">Nothing was dropped silently. If a real account was skipped, fix that row in your file and upload it again.</p>
        </details>
      )}

      {session.balanceSheet && <BalanceSheetPanel bs={session.balanceSheet} />}

      {session.intake?.aiError && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-slate-700 bg-surface-900/60 px-4 py-2.5 text-xs text-slate-300">
          <Sparkles size={14} className="mt-0.5 shrink-0 text-slate-500" />
          <span>
            Automatic suggestions were limited this time ({session.intake.aiError}). Accounts that matched by number or
            name are filled in; choose the rest under &ldquo;Becomes this account&rdquo;. You can finish everything by hand.
          </span>
        </div>
      )}

      {/* Mapping */}
      <div className="mt-5 mb-2 flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Match your accounts</p>
          <p className="text-2xs text-slate-500">Each account from your old system becomes one MeritBooks account. Amounts come straight from your file — we never change them.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex items-center gap-1.5 text-2xs text-slate-400 cursor-pointer">
            <input type="checkbox" className="accent-emerald-500" checked={onlyToCheck} onChange={(e) => setOnlyToCheck(e.target.checked)} />
            Only show ones to check ({toCheckCount})
          </label>
          <button type="button" disabled={busy || session.posted || strongCount === 0} onClick={() => save(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-300 hover:bg-emerald-500/15 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            title={`Confirms every suggestion we're at least ${Math.round(STRONG_MATCH_THRESHOLD * 100)}% sure of`}>
            <CheckCheck size={13} /> Accept all strong matches ({strongCount})
          </button>
        </div>
      </div>

      {pendingCount > 0 && (
        <div className="sticky top-2 z-10 mb-2 flex items-center justify-between gap-3 rounded-lg border border-brand-500/30 bg-surface-950/95 px-4 py-2 text-sm backdrop-blur">
          <span className="text-slate-200">{pendingCount} unsaved change{pendingCount === 1 ? '' : 's'}</span>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setPending({})} disabled={busy}
              className="inline-flex items-center gap-1 rounded-md border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:bg-white/[0.03] disabled:opacity-40">
              <Undo2 size={12} /> Discard
            </button>
            <button type="button" onClick={() => save(false)} disabled={busy}
              className="inline-flex items-center gap-1 rounded-md bg-brand-500 px-3 py-1 text-xs font-medium text-white hover:bg-brand-400 disabled:opacity-40">
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} Save changes
            </button>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-slate-800 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-surface-950 text-2xs uppercase tracking-wider text-slate-500">
              <th scope="col" className="text-left font-medium px-3 py-2">Your old account</th>
              <th scope="col" className="text-right font-medium px-3 py-2">Debit</th>
              <th scope="col" className="text-right font-medium px-3 py-2">Credit</th>
              <th scope="col" className="text-left font-medium px-3 py-2">Becomes this account</th>
              <th scope="col" className="text-left font-medium px-3 py-2">How sure</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {visibleRows.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-sm text-slate-500">Nothing left to check — every account has a confirmed or strong match.</td></tr>
            )}
            {visibleRows.map((r) => {
              const m = session.mapping[r.sourceAccount];
              const isPending = r.sourceAccount in pending;
              const value = isPending ? (pending[r.sourceAccount] ?? NONE) : (m?.targetAccountNumber ?? NONE);
              const strength: MatchStrength = isPending ? (pending[r.sourceAccount] ? 'confirmed' : 'missing') : strengthOf(r.sourceAccount);
              const selectId = `map-${r.sourceAccount}`;
              return (
                <tr key={r.sourceAccount} className={`bg-surface-900 ${strength === 'missing' ? 'ring-1 ring-inset ring-amber-500/20' : ''}`}>
                  <td className="px-3 py-2">
                    <label htmlFor={selectId} className="block">
                      <span className="font-mono text-slate-200">{r.sourceAccount}</span>
                      {r.sourceName && r.sourceName !== r.sourceAccount && <span className="block text-2xs text-slate-500">{r.sourceName}</span>}
                    </label>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-slate-300">{r.debitCents ? formatMoney(r.debitCents) : <span className="text-slate-600">—</span>}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-300">{r.creditCents ? formatMoney(r.creditCents) : <span className="text-slate-600">—</span>}</td>
                  <td className="px-3 py-2">
                    <select id={selectId} value={value} disabled={busy || session.posted}
                      onChange={(e) => stage(r.sourceAccount, e.target.value)}
                      className={`w-full min-w-[12rem] rounded-md border px-2 py-1 text-xs text-white bg-surface-950 ${strength === 'missing' ? 'border-amber-500/40' : isPending ? 'border-brand-500/50' : 'border-slate-700'}`}>
                      <option value={NONE}>— Choose an account —</option>
                      {coa.length === 0 && m?.targetAccountNumber && <option value={m.targetAccountNumber}>{m.targetAccountNumber}</option>}
                      {coa.map((a) => <option key={a.accountNumber} value={a.accountNumber}>{a.accountNumber} — {a.name}</option>)}
                    </select>
                  </td>
                  <td className="px-3 py-2"><StrengthBadge strength={strength} mapping={m} pending={isPending} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <OpeningEntryPreview lines={session.openingBalances} bal={bal} companyShortCode={session.companyShortCode} asOfDate={session.asOfDate} />

      {session.balanceSheet && !session.balanceSheet.standalone && session.balanceSheet.plNetCents !== 0 && (
        <label className="mt-4 flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 cursor-pointer">
          <input type="checkbox" className="mt-0.5 accent-amber-500" checked={!!session.plAcknowledged}
            disabled={busy || session.posted} onChange={(e) => onAckPl(e.target.checked)} />
          <span className="text-xs text-amber-200/90">
            <span className="font-medium">This is a mid-year switch.</span> My income and expense accounts carry{' '}
            <span className="font-mono">{formatMoney(Math.abs(session.balanceSheet.plNetCents))}</span> for this year so far,
            and that should carry over into MeritBooks as this year&apos;s activity.
          </span>
        </label>
      )}

      {/* Confirm + go live */}
      <div className="mt-6 rounded-xl border border-slate-800 bg-surface-900 p-4">
        {!session.tiedOut ? (
          <div className="flex items-start gap-3">
            <ShieldCheck size={18} className="mt-0.5 shrink-0 text-brand-400" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-white">Check the numbers match</p>
              <p className="text-xs text-slate-400 mt-0.5">
                Open the trial balance in your old system for {formatLongDate(session.asOfDate)} and compare it with the
                totals above. When they match, confirm — this is your sign-off before anything is posted.
              </p>
              <button type="button" disabled={!canConfirm || busy} onClick={() => onTieOut(true)}
                className="mt-3 inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                {busy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
                The numbers match — confirm
              </button>
              {!canConfirm && (
                <div className="mt-2 text-2xs text-slate-400">
                  <p className="mb-1">You can confirm once:</p>
                  <ul className="list-disc pl-4 space-y-0.5">
                    {pendingCount > 0 && <li>your {pendingCount} unsaved change{pendingCount === 1 ? ' is' : 's are'} saved</li>}
                    {blockers.map((b, i) => <li key={i}>{b}</li>)}
                  </ul>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div>
            <div className="flex items-center gap-2 text-sm text-emerald-300">
              <ShieldCheck size={16} /> <span className="font-medium">Numbers confirmed</span>
              {session.tiedOutAt && <span className="text-2xs text-slate-500">· {new Date(session.tiedOutAt).toLocaleString()}</span>}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button type="button" disabled={busy || session.posted || locked || blockers.length > 0} onClick={onPost}
                className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                {busy ? <Loader2 size={16} className="animate-spin" /> : <Scale size={16} />}
                Post opening balances &amp; go live
              </button>
              <button type="button" disabled={busy || session.posted} onClick={() => onTieOut(false)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:bg-white/[0.03] disabled:opacity-40 transition-colors">
                <Lock size={13} /> Reopen for edits
              </button>
            </div>
            {locked && <p className="mt-2 text-2xs text-rose-300">Unlock the month first (see the note above), then post.</p>}
          </div>
        )}
      </div>
    </div>
  );
}

// ───────────────────────────── small pieces ─────────────────────────────

function StrengthBadge({ strength, mapping, pending }: { strength: MatchStrength; mapping?: AccountMapping; pending: boolean }) {
  const cfg: Record<MatchStrength, { label: string; cls: string }> = {
    confirmed: { label: pending ? 'Your choice (unsaved)' : 'You chose', cls: 'bg-emerald-500/15 text-emerald-300' },
    strong: { label: 'Strong match', cls: 'bg-blue-500/15 text-blue-300' },
    check: { label: 'Check this', cls: 'bg-amber-500/15 text-amber-300' },
    missing: { label: 'Needs an account', cls: 'bg-rose-500/15 text-rose-300' },
  };
  const c = cfg[strength];
  const pct = mapping?.confidence != null && mapping.source !== 'human' ? `${Math.round(mapping.confidence * 100)}% sure` : null;
  const title = [pct, mapping?.reasoning].filter(Boolean).join(' — ') || undefined;
  return (
    <span title={title} className={`inline-flex items-center rounded-md px-2 py-0.5 text-2xs font-medium whitespace-nowrap ${c.cls}`}>
      {c.label}
    </span>
  );
}

function SubledgerTies({ ties }: { ties: NonNullable<SessionView['subledgerTies']> }) {
  return (
    <div className="mt-3 border-t border-slate-800 pt-2">
      <p className="text-2xs font-semibold uppercase tracking-wider text-slate-500 mb-1">Detail lists vs your balances</p>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-2xs text-slate-500">
            <th scope="col" className="text-left font-medium py-1">List</th>
            <th scope="col" className="text-right font-medium py-1">List total</th>
            <th scope="col" className="text-right font-medium py-1">Balance</th>
            <th scope="col" className="text-right font-medium py-1">Difference</th>
          </tr>
        </thead>
        <tbody>
          {ties.map((t) => (
            <tr key={t.key} className={t.ties ? 'text-slate-300' : 'text-amber-200'}>
              <td className="py-0.5">{t.ties ? <Check size={11} className="inline mr-1 text-emerald-400" /> : <AlertTriangle size={11} className="inline mr-1 text-amber-400" />}{t.label}</td>
              <td className="py-0.5 text-right font-mono">{formatMoney(t.subledgerCents)}</td>
              <td className="py-0.5 text-right font-mono">{formatMoney(t.controlCents)}</td>
              <td className="py-0.5 text-right font-mono">{t.ties ? '—' : formatMoney(Math.abs(t.varianceCents))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BalanceBanner({ balance }: { balance: BalanceCheck }) {
  if (balance.balanced) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">
        <Scale size={16} /> <span>Debits and credits are equal ({formatMoney(balance.totalDebitCents)} each).</span>
      </div>
    );
  }
  const diff = Math.abs(balance.differenceCents);
  const side = balance.differenceCents > 0 ? 'debits are higher' : 'credits are higher';
  return (
    <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
      <AlertTriangle size={16} className="mt-0.5 shrink-0" />
      <span>Debits and credits are <span className="font-mono font-semibold">{formatMoney(diff)}</span> apart ({side}). They must be equal before going live.</span>
    </div>
  );
}

function BalanceSheetPanel({ bs }: { bs: BalanceSheetCheck }) {
  const le = bs.liabilitiesCents + bs.equityCents;
  const ties = bs.standalone;
  return (
    <div className={`mt-3 rounded-xl border px-4 py-3 ${ties ? 'border-slate-800 bg-surface-900' : 'border-amber-500/30 bg-amber-500/5'}`}>
      <div className="flex items-center gap-2 mb-1">
        <Scale size={14} className={ties ? 'text-brand-400' : 'text-amber-400'} />
        <p className="text-2xs font-semibold uppercase tracking-wider text-slate-500">Balance sheet check</p>
      </div>
      <p className="text-2xs text-slate-500 mb-2">What the business owns should equal what it owes plus the owners&apos; share (assets = liabilities + equity).</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-1 text-sm">
        <ReconLine label="What you own (assets)" value={bs.assetsCents} />
        <ReconLine label="What you owe + owners' share" value={le} />
      </div>
      {ties ? (
        <p className="mt-2 text-2xs text-emerald-300 flex items-center gap-1.5"><Check size={12} /> It balances on its own.</p>
      ) : (
        <p className="mt-2 text-2xs text-amber-300/90 flex items-start gap-1.5">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span>
            The gap is this year&apos;s income and expenses so far ({formatMoney(Math.abs(bs.plNetCents))}) — normal for a
            mid-year switch. Tick the box below to confirm.
          </span>
        </p>
      )}
    </div>
  );
}

function OpeningEntryPreview({ lines, bal, companyShortCode, asOfDate }: {
  lines: OpeningBalanceLine[]; bal: BalanceCheck; companyShortCode: string; asOfDate: string;
}) {
  if (lines.length === 0) return null;
  return (
    <details className="mt-6 group" open={lines.length <= 25}>
      <summary className="flex cursor-pointer items-center gap-2 mb-2">
        <FileText size={15} className="text-brand-400" />
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          The opening entry we&apos;ll post
          <span className="text-slate-600 normal-case font-normal"> — one balanced journal entry dated {formatLongDate(asOfDate)}</span>
        </span>
      </summary>
      <div className="rounded-xl border border-slate-800 overflow-x-auto">
        <div className="flex items-center justify-between bg-surface-950 px-3 py-2 text-2xs text-slate-500">
          <span>Opening balances — <span className="font-mono text-slate-400">{companyShortCode}</span></span>
          <span>{lines.length} line{lines.length === 1 ? '' : 's'}</span>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-surface-950 text-2xs uppercase tracking-wider text-slate-500">
              <th scope="col" className="text-left font-medium px-3 py-2">Account</th>
              <th scope="col" className="text-right font-medium px-3 py-2">Debit</th>
              <th scope="col" className="text-right font-medium px-3 py-2">Credit</th>
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
    </details>
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

function SummaryStat({ label, value, tone }: { label: string; value: string; tone: 'ok' | 'muted' }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-surface-900 px-4 py-3">
      <p className={`text-xl font-semibold font-mono ${tone === 'ok' ? 'text-brand-400' : 'text-slate-200'}`}>{value}</p>
      <p className="text-2xs text-slate-500 mt-0.5">{label}</p>
    </div>
  );
}
