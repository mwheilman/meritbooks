'use client';

/**
 * P2 categorize/code — the propose→approve surface for the NL bar.
 *
 * 1. POST /api/nl/categorize → the matching bank-feed lines + a proposed GL coding
 *    per line (the account you named, or the AI categorizer's existing suggestion).
 *    An ai_decisions PROPOSED row is written. NOTHING posts.
 * 2. You review / adjust the account on each line.
 * 3. Approve → POST /api/bank-feed/approve per line — the EXISTING gated route that
 *    posts the balanced JE (period/balance/COA gates enforced). Clarify-before-book:
 *    if no merchant was identifiable the endpoint asks one question instead.
 */

import { useState, useEffect, useCallback } from 'react';
import { Loader2, AlertTriangle, HelpCircle, Check, Tags, Inbox } from 'lucide-react';
import { addToast } from '@/hooks/use-toast';
import { AiUnavailableNotice } from '@/components/ai/ai-unavailable-notice';

interface Candidate {
  transactionId: string;
  description: string;
  amountCents: number;
  transactionDate: string;
  status: string;
  proposedAccountId: string | null;
  proposedAccountLabel: string | null;
  confidence: number | null;
  source: 'user-named' | 'ai-suggested';
}
interface AccountOption { id: string; accountNumber: string; name: string; isActive: boolean; approvalStatus: string }

const fmt = (c: number) => (Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function CategorizePanel({ prompt, onDone }: { prompt: string; onDone: () => void }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [clarify, setClarify] = useState<string | null>(null);
  const [vendorQuery, setVendorQuery] = useState('');
  const [rows, setRows] = useState<Candidate[]>([]);
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [res, acctRes] = await Promise.all([
          fetch('/api/nl/categorize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }) }),
          fetch('/api/accounts'),
        ]);
        const data = await res.json().catch(() => null);
        if (!alive) return;
        // AI paused (org disabled / budget / no key) → calm notice, not a red error.
        if (data?.unavailable) { setUnavailable(data.message ?? null); return; }
        if (!res.ok) {
          setError(res.status === 402 ? 'AI budget cap reached — code these in the Bank Feed.' : (data?.error ?? 'Could not read that request.'));
          return;
        }
        const acct = await acctRes.json().catch(() => ({ data: [] }));
        setAccounts((acct.data ?? []) as AccountOption[]);
        if (data.clarifyingQuestion && (!data.candidates || data.candidates.length === 0)) { setClarify(data.clarifyingQuestion); return; }
        setVendorQuery(data.vendorQuery ?? '');
        const cands = (data.candidates ?? []) as Candidate[];
        setRows(cands);
        setChosen(Object.fromEntries(cands.map((c) => [c.transactionId, c.proposedAccountId ?? ''])));
      } catch {
        if (alive) setError('Could not reach the categorizer.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [prompt]);

  const usableAccounts = accounts.filter((a) => a.isActive && a.approvalStatus === 'APPROVED');

  const approveOne = useCallback(async (txnId: string) => {
    const accountId = chosen[txnId];
    if (!accountId) { addToast('error', 'Pick a GL account for that line first.'); return; }
    setBusy((b) => ({ ...b, [txnId]: true }));
    try {
      const res = await fetch('/api/bank-feed/approve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transaction_id: txnId, account_id: accountId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) { addToast('error', data?.error ?? 'Approve failed.'); return; }
      addToast('success', 'Coded & posted.');
      setRows((rs) => rs.filter((r) => r.transactionId !== txnId));
    } catch {
      addToast('error', 'Could not reach the approve route.');
    } finally {
      setBusy((b) => ({ ...b, [txnId]: false }));
    }
  }, [chosen]);

  const approveAll = useCallback(async () => {
    const ready = rows.filter((r) => chosen[r.transactionId]);
    for (const r of ready) {
      // Sequential — the approve route posts a JE per line; keep the ledger serialized.
      // eslint-disable-next-line no-await-in-loop
      await approveOne(r.transactionId);
    }
  }, [rows, chosen, approveOne]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-2xs uppercase tracking-wider text-emerald-400">
        <Tags size={13} /> Processing · code bank-feed charges
        <span className="ml-auto text-slate-500 normal-case tracking-normal">advisory — you review &amp; approve</span>
      </div>
      <p className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-slate-300">&ldquo;{prompt}&rdquo;</p>

      {loading && <div className="flex items-center gap-2 py-4 text-sm text-slate-400"><Loader2 size={15} className="animate-spin" /> Finding matching charges…</div>}

      {!loading && unavailable !== null && (
        <AiUnavailableNotice message={unavailable} hint="Code these in the Bank Feed in the meantime." />
      )}

      {!loading && !unavailable && error && (
        <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"><AlertTriangle size={15} className="mt-0.5 shrink-0" /> {error}</div>
      )}

      {!loading && clarify && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-3 text-sm text-amber-200">
          <HelpCircle size={16} className="mt-0.5 shrink-0" />
          <div><p className="font-medium">One quick question</p><p className="mt-0.5 text-amber-100/90">{clarify}</p></div>
        </div>
      )}

      {!loading && !unavailable && !error && !clarify && rows.length === 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-slate-700 bg-slate-800/50 px-3 py-3 text-sm text-slate-300">
          <Inbox size={16} className="mt-0.5 shrink-0 text-slate-500" />
          <span>No uncoded bank-feed charges match{vendorQuery ? ` “${vendorQuery}”` : ''}. They may already be posted.</span>
        </div>
      )}

      {!loading && !unavailable && !error && !clarify && rows.length > 0 && (
        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r.transactionId} className="rounded-xl border border-slate-800 bg-slate-900/40 px-3 py-2">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-slate-200">{r.description}</p>
                  <p className="text-2xs text-slate-500">{r.transactionDate}{r.confidence != null ? ` · AI ${(r.confidence * 100).toFixed(0)}%` : ''}{r.source === 'user-named' ? ' · you named the account' : ''}</p>
                </div>
                <span className="font-mono text-sm text-slate-200">${fmt(r.amountCents)}</span>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <select
                  value={chosen[r.transactionId] ?? ''}
                  onChange={(e) => setChosen((c) => ({ ...c, [r.transactionId]: e.target.value }))}
                  className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-white"
                >
                  <option value="">Select a GL account…</option>
                  {usableAccounts.map((a) => <option key={a.id} value={a.id}>{a.accountNumber} · {a.name}</option>)}
                </select>
                <button
                  onClick={() => approveOne(r.transactionId)}
                  disabled={busy[r.transactionId] || !chosen[r.transactionId]}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40 transition-colors"
                >
                  {busy[r.transactionId] ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Approve
                </button>
              </div>
            </div>
          ))}

          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={approveAll}
              disabled={Object.values(busy).some(Boolean) || rows.every((r) => !chosen[r.transactionId])}
              className="inline-flex items-center gap-2 rounded-lg border border-emerald-500/40 px-3 py-1.5 text-sm text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-40 transition-colors"
            >
              <Check size={14} /> Approve all coded ({rows.filter((r) => chosen[r.transactionId]).length})
            </button>
            <button onClick={onDone} className="text-2xs text-slate-500 hover:text-slate-300">Done</button>
          </div>
        </div>
      )}
    </div>
  );
}
