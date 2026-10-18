'use client';

import { useState, useCallback } from 'react';
import { Loader2, AlertCircle, Play, Eye, CheckCircle2, MinusCircle, AlertTriangle } from 'lucide-react';
import { clsx } from 'clsx';
import { useRouter } from 'next/navigation';
import { useQuery, addToast } from '@/hooks';
import { useHoverPeek, HoverPeekCard } from '@/components/hover-peek';
import { formatMoney } from '@meritbooks/shared';

interface JobResult {
  jobId: string; jobNumber?: string; jobName?: string; method: string;
  earnedToDateCents: number; priorRecognizedCents: number; deltaCents: number;
  status: 'posted' | 'unchanged' | 'skipped'; reason?: string; entryNumber?: string;
}
interface RunResponse {
  ok: boolean; preview: boolean; asOf: string;
  posted: number; unchanged: number; skipped: number; totalRecognizedDeltaCents: number;
  jobs: JobResult[];
}

function defaultAsOf(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0)).toISOString().slice(0, 10);
}

const METHOD_SHORT: Record<string, string> = {
  PCT_COMPLETE: 'POC %compl', PCT_COSTS_INCURRED: 'POC cost', COMPLETED_CONTRACT: 'Completed',
  MILESTONE: 'Milestone', POINT_OF_SALE: 'Point-of-sale', AS_BILLED: 'As billed',
  RATABLY: 'Ratable', SUBSCRIPTION: 'Subscription', CASH: 'Cash',
};

export function RevRecRun() {
  const [asOf, setAsOf] = useState(defaultAsOf());
  const [posting, setPosting] = useState(false);

  // Preview via GET (no posting); re-fetch keyed on asOf.
  const { data, isLoading, error, refetch } = useQuery<RunResponse>('/api/rev-rec/run', { as_of: asOf }, { key: `revrec-${asOf}` });
  const router = useRouter();
  const { peek, rowHandlers, cardHandlers, close } = useHoverPeek<JobResult>();

  const post = useCallback(async () => {
    if (!window.confirm(`Post revenue recognition as of ${asOf}? This writes journal entries.`)) return;
    setPosting(true);
    try {
      const res = await fetch('/api/rev-rec/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ as_of: asOf }) });
      const result = await res.json();
      if (!res.ok) { addToast('error', result.error ?? 'Recognition failed'); return; }
      addToast('success', `Posted ${result.posted} entr${result.posted === 1 ? 'y' : 'ies'} · ${formatMoney(result.totalRecognizedDeltaCents)} recognized`);
      refetch();
    } catch {
      addToast('error', 'Network error');
    } finally {
      setPosting(false);
    }
  }, [asOf, refetch]);

  const jobs = data?.jobs ?? [];
  const toPost = jobs.filter((j) => j.status === 'posted' && j.deltaCents !== 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <label className="text-2xs uppercase tracking-wider text-slate-500">Recognize as of</label>
          <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)}
            className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-md text-sm text-white font-mono" />
          <span className="inline-flex items-center gap-1 text-2xs text-slate-500"><Eye size={12} /> preview updates live</span>
        </div>
        <button onClick={post} disabled={posting || toPost.length === 0}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40">
          {posting ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Post recognition ({toPost.length})
        </button>
      </div>

      {data && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="To recognize" value={formatMoney(data.totalRecognizedDeltaCents)} tone="brand" />
          <Stat label="Jobs to post" value={String(toPost.length)} />
          <Stat label="Unchanged" value={String(data.unchanged)} />
          <Stat label="Skipped" value={String(data.skipped)} tone={data.skipped > 0 ? 'warn' : undefined} />
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="w-5 h-5 text-emerald-400 animate-spin" /></div>
      ) : error ? (
        <div className="card p-6 text-center"><AlertCircle className="mx-auto text-red-400 mb-2" size={20} /><p className="text-sm text-red-400">{error}</p></div>
      ) : jobs.length === 0 ? (
        <div className="card p-10 text-center text-sm text-slate-500">No recognizable jobs (active / complete / on-hold) found.</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-800">
                <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Job</th>
                <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Method</th>
                <th className="px-4 py-2.5 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Earned to date</th>
                <th className="px-4 py-2.5 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Already recognized</th>
                <th className="px-4 py-2.5 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">This run</th>
                <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/30">
              {jobs.map((j) => (
                <tr key={j.jobId} {...rowHandlers(j)} onClick={() => router.push(`/jobs/${j.jobId}`)} className="row-clickable">
                  <td className="px-4 py-2">
                    <span className="text-2xs font-mono text-slate-500">{j.jobNumber ?? '--'}</span>
                    <p className="text-sm text-slate-200 truncate max-w-[220px]">{j.jobName ?? j.jobId}</p>
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-400">{METHOD_SHORT[j.method] ?? j.method}</td>
                  <td className="px-4 py-2 text-right text-sm font-mono text-slate-300">{formatMoney(j.earnedToDateCents)}</td>
                  <td className="px-4 py-2 text-right text-sm font-mono text-slate-500">{formatMoney(j.priorRecognizedCents)}</td>
                  <td className={clsx('px-4 py-2 text-right text-sm font-mono', j.deltaCents > 0 ? 'text-emerald-400' : j.deltaCents < 0 ? 'text-red-400' : 'text-slate-600')}>
                    {j.deltaCents !== 0 ? formatMoney(j.deltaCents) : '—'}
                  </td>
                  <td className="px-4 py-2">
                    {j.status === 'posted' && j.deltaCents !== 0 ? (
                      <span className="inline-flex items-center gap-1 text-2xs text-brand-300">{data?.preview ? <Eye size={11} /> : <CheckCircle2 size={11} />}{data?.preview ? 'will post' : `posted ${j.entryNumber ?? ''}`}</span>
                    ) : j.status === 'skipped' ? (
                      <span className="inline-flex items-center gap-1 text-2xs text-amber-400" title={j.reason}><AlertTriangle size={11} /> {j.reason ?? 'skipped'}</span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-2xs text-slate-600"><MinusCircle size={11} /> unchanged</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <HoverPeekCard
        rect={peek?.rect ?? null} visible={!!peek} cardHandlers={cardHandlers}
        onOpen={peek ? () => { const id = peek.item.jobId; close(); router.push(`/jobs/${id}`); } : undefined}
      >
        {peek && (
          <div className="p-3">
            <div className="mb-1"><span className="text-2xs font-mono text-slate-500">{peek.item.jobNumber ?? '--'}</span>
              <p className="text-sm font-semibold text-white truncate">{peek.item.jobName ?? peek.item.jobId}</p></div>
            <div className="text-2xs text-slate-500 mb-2">{METHOD_SHORT[peek.item.method] ?? peek.item.method}</div>
            <div className="rounded-md bg-slate-800/40 px-3 py-2 space-y-0.5">
              <div className="flex justify-between text-2xs"><span className="text-slate-500">Earned to date</span><span className="font-mono text-slate-300">{formatMoney(peek.item.earnedToDateCents)}</span></div>
              <div className="flex justify-between text-2xs"><span className="text-slate-500">Prior recognized</span><span className="font-mono text-slate-400">{formatMoney(peek.item.priorRecognizedCents)}</span></div>
              <div className="flex justify-between text-2xs"><span className="text-slate-500">To recognize now</span><span className={'font-mono ' + (peek.item.deltaCents > 0 ? 'text-emerald-400' : peek.item.deltaCents < 0 ? 'text-red-400' : 'text-slate-500')}>{formatMoney(peek.item.deltaCents)}</span></div>
            </div>
            {peek.item.reason && <div className="mt-2 text-2xs text-amber-400">{peek.item.reason}</div>}
          </div>
        )}
      </HoverPeekCard>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'brand' | 'warn' }) {
  return (
    <div className="card p-3">
      <p className="text-2xs uppercase tracking-wider text-slate-500 font-semibold">{label}</p>
      <p className={clsx('text-lg font-mono font-semibold mt-1', tone === 'brand' ? 'text-emerald-400' : tone === 'warn' ? 'text-amber-400' : 'text-white')}>{value}</p>
    </div>
  );
}
