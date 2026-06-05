'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { Sparkles, Loader2, X, AlertTriangle, Lightbulb, Check, HelpCircle } from 'lucide-react';

interface LocationOption { id: string; name: string; short_code: string }

interface ProposalLine {
  account_id: string | null;
  account_number: string;
  account_label: string;
  debit_cents: number;
  credit_cents: number;
  memo: string | null;
}
interface Proposal {
  memo: string;
  lines: ProposalLine[];
  balanced: boolean;
  totalDebitCents: number;
  totalCreditCents: number;
  prediction: { type: 'NONE' | 'CAPEX' | 'PREPAID' | 'DEFERRED_REVENUE'; rationale: string | null };
  confidence: number;
  clarifyingQuestion: string | null;
  notes: string | null;
  unresolvedAccounts: string[];
}

interface EditLine { account_id: string | null; account_number: string; account_label: string; debit: string; credit: string; memo: string }

const fmt = (cents: number) => (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const toCents = (s: string) => Math.round((Number(String(s).replace(/[$,\s]/g, '')) || 0) * 100);

export function JeAiComposer({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [locationId, setLocationId] = useState('');
  const [entryDate, setEntryDate] = useState(new Date().toISOString().split('T')[0]);
  const [description, setDescription] = useState('');
  const [composing, setComposing] = useState(false);
  const [error, setError] = useState('');

  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [decisionId, setDecisionId] = useState<string | null>(null);
  const [gateway, setGateway] = useState<{ costCents: number; budgetState: string; message: string | null } | null>(null);
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<EditLine[]>([]);
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState('');

  useEffect(() => {
    fetch('/api/locations')
      .then((r) => (r.ok ? r.json() : []))
      .then((d: LocationOption[]) => {
        const arr = Array.isArray(d) ? d : [];
        setLocations(arr);
        if (arr.length === 1) setLocationId(arr[0].id);
      })
      .catch(() => setLocations([]));
  }, []);

  const compose = useCallback(async () => {
    setError(''); setProposal(null); setPostError(''); setDecisionId(null); setGateway(null);
    if (!locationId) { setError('Select a company first.'); return; }
    if (description.trim().length < 3) { setError('Describe the transaction first.'); return; }
    setComposing(true);
    try {
      const res = await fetch('/api/journal-entries/compose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description, location_id: locationId }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Compose failed'); return; }
      const p = data.proposal as Proposal;
      setProposal(p);
      setDecisionId(data.decisionId ?? null);
      setGateway(data.gateway ? { costCents: data.gateway.costCents, budgetState: data.gateway.budgetState, message: data.gateway.message } : null);
      setMemo(p.memo);
      setLines(p.lines.map((l) => ({
        account_id: l.account_id,
        account_number: l.account_number,
        account_label: l.account_label,
        debit: l.debit_cents ? fmt(l.debit_cents) : '',
        credit: l.credit_cents ? fmt(l.credit_cents) : '',
        memo: l.memo ?? '',
      })));
    } catch {
      setError('Could not reach the composer.');
    } finally {
      setComposing(false);
    }
  }, [locationId, description]);

  const totals = useMemo(() => {
    const d = lines.reduce((s, l) => s + toCents(l.debit), 0);
    const c = lines.reduce((s, l) => s + toCents(l.credit), 0);
    return { d, c, balanced: d === c && d > 0 };
  }, [lines]);

  const allResolved = lines.length >= 2 && lines.every((l) => l.account_id);

  const updateLine = (i: number, patch: Partial<EditLine>) =>
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const post = useCallback(async () => {
    setPostError('');
    if (!totals.balanced) { setPostError('Entry is not balanced.'); return; }
    if (!allResolved) { setPostError('Every line needs a valid account.'); return; }
    setPosting(true);
    try {
      const payload = {
        location_id: locationId,
        entry_date: entryDate,
        entry_type: 'STANDARD' as const,
        memo,
        post_immediately: true,
        decision_id: decisionId ?? undefined,
        lines: lines
          .filter((l) => l.account_id && (toCents(l.debit) > 0 || toCents(l.credit) > 0))
          .map((l) => ({
            account_id: l.account_id as string,
            debit_cents: toCents(l.debit),
            credit_cents: toCents(l.credit),
            location_id: locationId,
            memo: l.memo || null,
          })),
      };
      const res = await fetch('/api/journal-entries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) { setPostError(data.error ?? 'Failed to post entry'); return; }
      onSuccess();
    } catch {
      setPostError('Could not post the entry.');
    } finally {
      setPosting(false);
    }
  }, [totals.balanced, allResolved, locationId, entryDate, memo, lines, decisionId, onSuccess]);

  return (
    <div className="rounded-xl border border-emerald-500/30 bg-slate-900/60 p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Sparkles size={16} className="text-emerald-400" />
          <h3 className="text-sm font-semibold text-white">Compose with AI</h3>
          <span className="text-2xs text-slate-500">advisory — you review and post</span>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-300"><X size={16} /></button>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-3">
        <div className="col-span-2">
          <label className="block text-xs text-slate-400 mb-1">Company</label>
          <select value={locationId} onChange={(e) => setLocationId(e.target.value)}
            className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white">
            <option value="">Select a company…</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.short_code})</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1">Entry date</label>
          <input type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)}
            className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white" />
        </div>
      </div>

      <label className="block text-xs text-slate-400 mb-1">Describe the transaction in plain English</label>
      <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3}
        placeholder="e.g. Paid $1,200 for a 12-month business insurance policy by check from operating checking."
        className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-emerald-500/50" />

      <div className="mt-3 flex items-center gap-3">
        <button onClick={compose} disabled={composing}
          className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50 transition-colors">
          {composing ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />} Compose entry
        </button>
        {error && <span className="text-xs text-rose-400 flex items-center gap-1"><AlertTriangle size={13} /> {error}</span>}
      </div>

      {proposal && (
        <div className="mt-5 space-y-3">
          {proposal.clarifyingQuestion && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
              <HelpCircle size={15} className="mt-0.5 shrink-0" />
              <span><span className="font-medium">Before you post: </span>{proposal.clarifyingQuestion}</span>
            </div>
          )}
          {proposal.prediction.type !== 'NONE' && (
            <div className="flex items-start gap-2 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-sm text-sky-200">
              <Lightbulb size={15} className="mt-0.5 shrink-0" />
              <span><span className="font-medium">{proposal.prediction.type.replace('_', ' ')}: </span>{proposal.prediction.rationale}</span>
            </div>
          )}
          {proposal.notes && <p className="text-xs text-slate-400 italic">{proposal.notes}</p>}
          {proposal.unresolvedAccounts.length > 0 && (
            <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
              The AI referenced account(s) not in your chart: {proposal.unresolvedAccounts.join(', ')}. Adjust before posting.
            </div>
          )}

          <div>
            <label className="block text-xs text-slate-400 mb-1">Memo</label>
            <input value={memo} onChange={(e) => setMemo(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white" />
          </div>

          <div className="rounded-xl border border-slate-800 overflow-hidden">
            <div className="grid grid-cols-[1fr_110px_110px] gap-2 px-3 py-2 bg-slate-800/60 text-2xs uppercase tracking-wider text-slate-500">
              <span>Account</span><span className="text-right">Debit</span><span className="text-right">Credit</span>
            </div>
            {lines.map((l, i) => (
              <div key={i} className="grid grid-cols-[1fr_110px_110px] gap-2 px-3 py-2 items-center border-t border-slate-800">
                <div className="min-w-0">
                  <p className={`text-sm truncate ${l.account_id ? 'text-slate-200' : 'text-rose-300'}`}>{l.account_label}</p>
                  <input value={l.memo} onChange={(e) => updateLine(i, { memo: e.target.value })}
                    placeholder="line memo" className="mt-0.5 w-full bg-transparent text-2xs text-slate-500 placeholder:text-slate-600 focus:outline-none" />
                </div>
                <input value={l.debit} onChange={(e) => updateLine(i, { debit: e.target.value, credit: '' })}
                  className="rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-sm text-right text-white font-mono" placeholder="0.00" />
                <input value={l.credit} onChange={(e) => updateLine(i, { credit: e.target.value, debit: '' })}
                  className="rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-sm text-right text-white font-mono" placeholder="0.00" />
              </div>
            ))}
            <div className="grid grid-cols-[1fr_110px_110px] gap-2 px-3 py-2 border-t border-slate-700 bg-slate-800/40 text-sm font-mono">
              <span className={`flex items-center gap-1.5 ${totals.balanced ? 'text-emerald-400' : 'text-amber-400'}`}>
                {totals.balanced ? <><Check size={13} /> Balanced</> : 'Out of balance'}
              </span>
              <span className="text-right text-slate-200">{fmt(totals.d)}</span>
              <span className="text-right text-slate-200">{fmt(totals.c)}</span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button onClick={post} disabled={posting || !totals.balanced || !allResolved}
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              {posting ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Post entry
            </button>
            <span className="text-2xs text-slate-500">Confidence {(proposal.confidence * 100).toFixed(0)}%</span>
            {gateway && (
              <span className="text-2xs text-slate-500" title={`Budget: ${gateway.budgetState}`}>
                · metered ${(gateway.costCents / 100).toFixed(4)}
              </span>
            )}
            {decisionId && <span className="text-2xs text-slate-500">· logged for audit</span>}
            {gateway?.message && <span className="text-2xs text-amber-400">· {gateway.message}</span>}
            {postError && <span className="text-xs text-rose-400">{postError}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
