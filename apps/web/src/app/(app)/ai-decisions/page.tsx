'use client';

import { useState } from 'react';
import { Loader2, AlertCircle, Sparkles, ChevronDown, ChevronRight, CheckCircle2, XCircle, Clock, HelpCircle, Lightbulb } from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery, addToast } from '@/hooks';
import { api } from '@/lib/api-client';
import { PageHeader, EmptyState } from '@/components/ui';

interface ProposedLine { account_label?: string; account_number?: string; debit_cents?: number; credit_cents?: number; memo?: string | null }
interface ProposedOutput {
  memo?: string;
  lines?: ProposedLine[];
  prediction?: { type: string; rationale: string | null };
  totalDebitCents?: number;
  totalCreditCents?: number;
  unresolvedAccounts?: string[];
}
interface Decision {
  id: string;
  location_id: string | null;
  location_name: string | null;
  feature: string;
  model_used: string | null;
  input_summary: string;
  proposed_output: ProposedOutput;
  confidence: number | null;
  reasoning: string | null;
  clarifying_question: string | null;
  status: 'PROPOSED' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
  disposition_by_user: string | null;
  disposition_at: string | null;
  disposition_note: string | null;
  posted_gl_entry_id: string | null;
  entry_number: string | null;
  cost_cents: number | null;
  created_at: string;
}

const fmt = (c: number) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const STATUSES = ['ALL', 'PROPOSED', 'APPROVED', 'REJECTED'] as const;

const statusBadge = (s: Decision['status']) => {
  const map: Record<string, { cls: string; icon: typeof CheckCircle2; label: string }> = {
    PROPOSED: { cls: 'text-amber-400 bg-amber-500/10 border-amber-500/30', icon: Clock, label: 'Proposed' },
    APPROVED: { cls: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30', icon: CheckCircle2, label: 'Approved' },
    REJECTED: { cls: 'text-rose-400 bg-rose-500/10 border-rose-500/30', icon: XCircle, label: 'Rejected' },
    EXPIRED: { cls: 'text-slate-400 bg-slate-500/10 border-slate-500/30', icon: Clock, label: 'Expired' },
  };
  return map[s] ?? map.EXPIRED;
};

export default function AiDecisionsPage() {
  const [filter, setFilter] = useState<(typeof STATUSES)[number]>('ALL');
  const params: Record<string, string> | undefined = filter === 'ALL' ? undefined : { status: filter };
  const { data, isLoading, error, refetch } = useQuery<{ decisions: Decision[] }>('/api/ai/decisions', params);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const decisions = data?.decisions ?? [];

  const reject = async (d: Decision) => {
    const note = window.prompt('Reject this AI proposal? Optional note:') ?? undefined;
    setBusy(d.id);
    const res = await api.patch('/api/ai/decisions', { decision_id: d.id, status: 'REJECTED', note });
    setBusy(null);
    if (res.error) { addToast('error', res.error.error); return; }
    addToast('success', 'Proposal rejected');
    refetch();
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <PageHeader
        title="AI Decision Log"
        description="Every AI proposal, its inputs, the entry it suggested, and how it was dispositioned — a full audit trail. Nothing AI-suggested posts without a record here."
      />

      <div className="flex items-center gap-2 mb-4">
        {STATUSES.map((s) => (
          <button key={s} onClick={() => setFilter(s)}
            className={clsx('px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors',
              filter === s ? 'bg-emerald-600 border-emerald-500 text-white' : 'border-slate-700 text-slate-400 hover:text-slate-200')}>
            {s === 'ALL' ? 'All' : statusBadge(s as Decision['status']).label}
          </button>
        ))}
      </div>

      {isLoading && <div className="flex items-center justify-center py-20 text-slate-500"><Loader2 className="animate-spin" size={20} /></div>}
      {error && !isLoading && <div className="card p-4 flex items-center gap-2 text-red-400 text-sm"><AlertCircle size={16} /> {error}</div>}

      {!isLoading && !error && (
        decisions.length === 0 ? (
          <EmptyState icon={Sparkles} title="No AI decisions yet" description="When you compose an entry with AI, every proposal is recorded here for review and audit." />
        ) : (
          <div className="space-y-2">
            {decisions.map((d) => {
              const badge = statusBadge(d.status);
              const Icon = badge.icon;
              const isOpen = expanded === d.id;
              return (
                <div key={d.id} className="card overflow-hidden">
                  <button onClick={() => setExpanded(isOpen ? null : d.id)}
                    className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-800/30">
                    {isOpen ? <ChevronDown size={15} className="text-slate-500 shrink-0" /> : <ChevronRight size={15} className="text-slate-500 shrink-0" />}
                    <span className="text-2xs font-mono uppercase tracking-wide text-slate-500 shrink-0">{d.feature.replace(/_/g, ' ')}</span>
                    <span className="text-sm text-slate-200 truncate flex-1">{d.input_summary}</span>
                    {d.clarifying_question && <HelpCircle size={14} className="text-amber-400 shrink-0" />}
                    {d.confidence != null && <span className="text-2xs text-slate-500 shrink-0">{(d.confidence * 100).toFixed(0)}%</span>}
                    <span className={clsx('inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-2xs font-medium shrink-0', badge.cls)}>
                      <Icon size={11} /> {badge.label}
                    </span>
                  </button>

                  {isOpen && (
                    <div className="border-t border-slate-800 px-4 py-3 space-y-3 text-sm">
                      <div className="flex flex-wrap gap-x-6 gap-y-1 text-2xs text-slate-500">
                        {d.location_name && <span>Entity: <span className="text-slate-300">{d.location_name}</span></span>}
                        <span>Model: <span className="text-slate-300">{d.model_used ?? '—'}</span></span>
                        {d.cost_cents != null && <span>Metered: <span className="text-slate-300">${(d.cost_cents / 100).toFixed(4)}</span></span>}
                        <span>{new Date(d.created_at).toLocaleString()}</span>
                        {d.entry_number && <span>Posted: <span className="text-emerald-400 font-mono">{d.entry_number}</span></span>}
                      </div>

                      {d.clarifying_question && (
                        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-200 text-xs">
                          <HelpCircle size={14} className="mt-0.5 shrink-0" /> <span>{d.clarifying_question}</span>
                        </div>
                      )}
                      {d.proposed_output?.prediction && d.proposed_output.prediction.type !== 'NONE' && (
                        <div className="flex items-start gap-2 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-sky-200 text-xs">
                          <Lightbulb size={14} className="mt-0.5 shrink-0" />
                          <span><span className="font-medium">{d.proposed_output.prediction.type.replace(/_/g, ' ')}: </span>{d.proposed_output.prediction.rationale}</span>
                        </div>
                      )}

                      {Array.isArray(d.proposed_output?.lines) && d.proposed_output.lines.length > 0 && (
                        <div className="rounded-lg border border-slate-800 overflow-hidden">
                          <div className="grid grid-cols-[1fr_110px_110px] gap-2 px-3 py-1.5 bg-slate-800/50 text-2xs uppercase tracking-wide text-slate-500">
                            <span>{d.proposed_output.memo || 'Proposed entry'}</span><span className="text-right">Debit</span><span className="text-right">Credit</span>
                          </div>
                          {d.proposed_output.lines.map((l, i) => (
                            <div key={i} className="grid grid-cols-[1fr_110px_110px] gap-2 px-3 py-1.5 border-t border-slate-800/60 text-xs">
                              <span className="text-slate-300 truncate">{l.account_label ?? l.account_number}</span>
                              <span className="text-right font-mono text-slate-300">{l.debit_cents ? fmt(l.debit_cents) : ''}</span>
                              <span className="text-right font-mono text-slate-300">{l.credit_cents ? fmt(l.credit_cents) : ''}</span>
                            </div>
                          ))}
                        </div>
                      )}

                      {d.reasoning && <p className="text-xs text-slate-400 italic">{d.reasoning}</p>}

                      {d.status === 'REJECTED' && d.disposition_note && (
                        <p className="text-xs text-rose-300">Rejected: {d.disposition_note}</p>
                      )}

                      {d.status === 'PROPOSED' && (
                        <div className="flex items-center gap-2 pt-1">
                          <span className="text-2xs text-slate-500">This proposal was never posted.</span>
                          <button className="btn btn-ghost btn-sm text-rose-400" onClick={() => reject(d)} disabled={busy === d.id}>
                            {busy === d.id ? <Loader2 size={13} className="animate-spin" /> : <XCircle size={13} />} Reject
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )
      )}
    </div>
  );
}
