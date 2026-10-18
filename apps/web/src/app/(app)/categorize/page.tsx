'use client';

import { useState, useMemo } from 'react';
import { Loader2, Sparkles, Wand2, CheckCircle2, Tag, Building2, AlertCircle } from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery, addToast } from '@/hooks';
import { api } from '@/lib/api-client';
import { PageHeader } from '@/components/ui';

interface LocationOption { id: string; name: string; short_code?: string }
interface Account { id: string; account_number: string; name: string; account_type: string }
interface Suggestion {
  accountId: string | null; accountNumber: string | null; accountName: string | null;
  vendorId: string | null; vendorName: string | null;
  departmentId: string | null; departmentName: string | null;
  confidence: number; reasoning: string; source: 'pattern' | 'ai'; decisionId: string | null;
}

const toCents = (s: string) => Math.round((parseFloat(s) || 0) * 100);
const fmt = (c: number) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const FUNDING_TYPES = ['ASSET', 'LIABILITY'];

export default function CategorizePage() {
  const { data: locData } = useQuery<LocationOption[]>('/api/locations');
  const locations = locData ?? [];

  const [locationId, setLocationId] = useState('');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [suggesting, setSuggesting] = useState(false);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [expenseId, setExpenseId] = useState('');
  const [fundingId, setFundingId] = useState('');
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState('');

  const amountCents = toCents(amount);
  const fundingAccounts = useMemo(() => accounts.filter((a) => FUNDING_TYPES.includes(a.account_type)), [accounts]);
  const expenseLabel = (id: string) => { const a = accounts.find((x) => x.id === id); return a ? `${a.account_number} · ${a.name}` : ''; };

  const suggest = async () => {
    setError(''); setSuggestion(null);
    if (!locationId) { setError('Select a company first.'); return; }
    if (description.trim().length < 3) { setError('Describe the transaction first.'); return; }
    if (amountCents <= 0) { setError('Enter an amount greater than zero.'); return; }
    setSuggesting(true);
    const res = await api.post<{ suggestion: Suggestion; accounts: Account[] }>('/api/categorize', {
      description, amount_cents: amountCents, location_id: locationId,
    });
    setSuggesting(false);
    if (res.error) { setError(res.error.error); return; }
    const s = res.data!.suggestion;
    setSuggestion(s);
    setAccounts(res.data!.accounts);
    setExpenseId(s.accountId ?? '');
    setFundingId('');
  };

  const post = async () => {
    if (!expenseId || !fundingId) { addToast('error', 'Pick both the expense account and how it was paid.'); return; }
    if (expenseId === fundingId) { addToast('error', 'The expense and funding account must differ.'); return; }
    setPosting(true);
    const today = new Date().toISOString().split('T')[0];
    const res = await api.post<{ entry: { entryNumber: string } }>('/api/journal-entries', {
      location_id: locationId,
      entry_date: today,
      entry_type: 'STANDARD',
      memo: description.slice(0, 500),
      post_immediately: true,
      decision_id: suggestion?.decisionId ?? undefined,
      lines: [
        { account_id: expenseId, debit_cents: amountCents, credit_cents: 0, location_id: locationId, department_id: suggestion?.departmentId ?? undefined, memo: suggestion?.vendorName ?? null },
        { account_id: fundingId, debit_cents: 0, credit_cents: amountCents, location_id: locationId },
      ],
    });
    setPosting(false);
    if (res.error) { addToast('error', res.error.error); return; }
    addToast('success', `Posted ${res.data?.entry?.entryNumber ?? 'entry'} — coded & logged`);
    // Learning loop: teach this confirmed coding so tier 1 catches it next time.
    void api.post('/api/categorize/learn', {
      description,
      account_id: expenseId,
      vendor_id: suggestion?.vendorId ?? undefined,
      department_id: suggestion?.departmentId ?? undefined,
      location_id: locationId,
    });
    setSuggestion(null); setDescription(''); setAmount(''); setExpenseId(''); setFundingId('');
  };

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <PageHeader
        title="AI Categorizer"
        description="Describe an incoming transaction; the AI proposes the right GL account, vendor, and department from your own books. Every suggestion is recorded in the AI Decision Log."
      />

      <div className="card p-5 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="sm:col-span-2">
            <label className="block text-xs text-slate-400 mb-1">Company</label>
            <select className="input w-full" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">Select…</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}{l.short_code ? ` (${l.short_code})` : ''}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Amount</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">$</span>
              <input className="input w-full pl-6" inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
          </div>
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1">Transaction description</label>
          <textarea className="input w-full h-20 resize-none" placeholder='e.g. "ACME Office Supply — printer toner and paper"'
            value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        {error && <div className="flex items-center gap-2 text-rose-400 text-sm"><AlertCircle size={15} /> {error}</div>}
        <button className="btn btn-primary" onClick={suggest} disabled={suggesting}>
          {suggesting ? <Loader2 size={15} className="animate-spin" /> : <Wand2 size={15} />} Suggest category
        </button>
      </div>

      {suggestion && (
        <div className="card p-5 mt-4 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white flex items-center gap-2"><Sparkles size={15} className="text-emerald-400" /> Proposed coding</h3>
            <span className={clsx('inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-2xs font-medium',
              suggestion.source === 'ai' ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' : 'text-sky-400 border-sky-500/30 bg-sky-500/10')}>
              {suggestion.source === 'ai' ? 'AI' : 'Pattern match'} · {(suggestion.confidence * 100).toFixed(0)}%
            </span>
          </div>

          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {suggestion.vendorName && <span className="inline-flex items-center gap-1.5 text-slate-300"><Tag size={13} className="text-slate-500" /> {suggestion.vendorName}</span>}
            {suggestion.departmentName && <span className="inline-flex items-center gap-1.5 text-slate-300"><Building2 size={13} className="text-slate-500" /> {suggestion.departmentName}</span>}
          </div>
          {suggestion.reasoning && <p className="text-xs text-slate-400 italic">{suggestion.reasoning}</p>}
          {!suggestion.accountId && <p className="text-xs text-amber-400">The AI didn&apos;t match a specific account — pick one below.</p>}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
            <div>
              <label className="block text-xs text-slate-400 mb-1">Code to account (debit)</label>
              <select className="input w-full" value={expenseId} onChange={(e) => setExpenseId(e.target.value)}>
                <option value="">Select account…</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.account_number} · {a.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Paid from / owed to (credit)</label>
              <select className="input w-full" value={fundingId} onChange={(e) => setFundingId(e.target.value)}>
                <option value="">Select account…</option>
                {fundingAccounts.map((a) => <option key={a.id} value={a.id}>{a.account_number} · {a.name}</option>)}
              </select>
            </div>
          </div>

          {expenseId && fundingId && (
            <div className="rounded-lg border border-slate-800 overflow-hidden text-sm">
              <div className="grid grid-cols-[1fr_110px_110px] gap-2 px-3 py-1.5 bg-slate-800/50 text-2xs uppercase tracking-wide text-slate-500">
                <span>Entry preview</span><span className="text-right">Debit</span><span className="text-right">Credit</span>
              </div>
              <div className="grid grid-cols-[1fr_110px_110px] gap-2 px-3 py-1.5 border-t border-slate-800/60">
                <span className="text-slate-300 truncate">{expenseLabel(expenseId)}</span>
                <span className="text-right font-mono text-slate-300">{fmt(amountCents)}</span><span />
              </div>
              <div className="grid grid-cols-[1fr_110px_110px] gap-2 px-3 py-1.5 border-t border-slate-800/60">
                <span className="text-slate-300 truncate">{expenseLabel(fundingId)}</span>
                <span /><span className="text-right font-mono text-slate-300">{fmt(amountCents)}</span>
              </div>
            </div>
          )}

          <div className="flex items-center gap-3">
            <button className="btn btn-primary" onClick={post} disabled={posting || !expenseId || !fundingId}>
              {posting ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />} Post entry
            </button>
            {suggestion.decisionId && <span className="text-2xs text-slate-500">Logged for audit</span>}
          </div>
        </div>
      )}
    </div>
  );
}
