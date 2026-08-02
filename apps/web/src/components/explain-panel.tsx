'use client';

/**
 * ExplainPanel — the reusable, object-agnostic "Explain this ___" drawer/panel.
 *
 * Drop it onto any record detail: `<ExplainPanel kind="JOURNAL_ENTRY" id={id} />`.
 * It calls GET /api/explain, which deterministically gathers the record's facts
 * and (when available) has the Core AI gateway PHRASE them — the model may word
 * the paragraph but every figure comes from the ledger. The panel surfaces the
 * grounded narrative, a per-line debit/credit direction breakdown, and a
 * "Based on" fact list with links to the underlying records.
 *
 * AI features use the indigo accent (design system); numbers use the mono face.
 */

import { useState } from 'react';
import Link from 'next/link';
import { clsx } from 'clsx';
import {
  Sparkles, Loader2, AlertCircle, RefreshCw, ArrowUpRight,
  ArrowDownRight, ArrowRight, ShieldCheck, ExternalLink,
} from 'lucide-react';
import { formatMoney } from '@meritbooks/shared';
import { useQuery } from '@/hooks';
import type { ExplainKind, ExplainResult } from '@/lib/explain';

interface ExplainPanelProps {
  kind: ExplainKind;
  id: string;
  /** Optional heading override. */
  title?: string;
  className?: string;
}

const KIND_NOUN: Record<ExplainKind, string> = {
  JOURNAL_ENTRY: 'entry',
  BILL: 'bill',
};

export function ExplainPanel({ kind, id, title, className }: ExplainPanelProps) {
  // On-demand: don't spend AI budget until the user asks. `run` flips enabled.
  const [run, setRun] = useState(false);
  const { data, isLoading, error, refetch } = useQuery<ExplainResult>(
    '/api/explain',
    { kind, id },
    { enabled: run && !!id },
  );

  const heading = title ?? `Explain this ${KIND_NOUN[kind]}`;

  return (
    <section className={clsx('rounded-lg border border-indigo-500/25 bg-indigo-500/[0.04]', className)}>
      <header className="flex items-center justify-between px-4 py-3 border-b border-indigo-500/15">
        <div className="flex items-center gap-2">
          <Sparkles size={15} className="text-indigo-400" />
          <h3 className="text-sm font-semibold text-slate-100">{heading}</h3>
        </div>
        {!run && (
          <button
            onClick={() => setRun(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-indigo-600 text-white hover:bg-indigo-500 transition-colors"
          >
            <Sparkles size={12} /> Explain
          </button>
        )}
        {run && (
          <button
            onClick={() => refetch()}
            disabled={isLoading}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium text-indigo-300 hover:bg-indigo-500/10 disabled:opacity-50"
          >
            <RefreshCw size={12} className={clsx(isLoading && 'animate-spin')} /> Regenerate
          </button>
        )}
      </header>

      <div className="px-4 py-3">
        {/* Idle */}
        {!run && (
          <p className="text-xs text-slate-400">
            Get a plain-English, ledger-grounded explanation of what this {KIND_NOUN[kind]} is,
            why it debits and credits the way it does, and who or what proposed and approved it.
          </p>
        )}

        {/* Loading */}
        {run && isLoading && (
          <div className="flex items-center gap-2 text-xs text-slate-400 py-2">
            <Loader2 size={14} className="animate-spin text-indigo-400" />
            Gathering the facts and drafting the explanation…
          </div>
        )}

        {/* Error */}
        {run && !isLoading && error && (
          <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/[0.06] px-3 py-2 text-xs text-red-300">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <div>
              <div className="font-medium">Could not build the explanation.</div>
              <div className="text-red-400/80 mt-0.5">{error}</div>
            </div>
          </div>
        )}

        {/* Populated */}
        {run && !isLoading && !error && data && (
          <div className="space-y-4">
            {/* Narrative */}
            <p className="text-sm leading-relaxed text-slate-200">{data.narrative}</p>

            {/* Provenance chip */}
            <div className="flex items-center gap-2 text-2xs">
              <span
                className={clsx(
                  'inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-medium',
                  data.meta.source === 'ai'
                    ? 'bg-indigo-500/10 text-indigo-300'
                    : 'bg-slate-700/40 text-slate-400',
                )}
              >
                <ShieldCheck size={11} />
                {data.meta.source === 'ai'
                  ? `AI-phrased · figures from the ledger${data.meta.model ? ` · ${data.meta.model}` : ''}`
                  : 'Deterministic (AI unavailable)'}
              </span>
              {data.meta.message && data.meta.source === 'deterministic' && (
                <span className="text-slate-600">{data.meta.message}</span>
              )}
            </div>

            {/* Posting lines with derived direction */}
            {data.explanation.lines.length > 0 && (
              <div>
                <h4 className="text-2xs text-slate-500 uppercase tracking-wider font-semibold mb-1.5">
                  Posting lines
                </h4>
                <ul className="space-y-1">
                  {data.explanation.lines.map((l, i) => {
                    const isDebit = l.side === 'debit';
                    const increase = l.effect === 'increase';
                    const Icon = increase ? ArrowUpRight : ArrowDownRight;
                    return (
                      <li
                        key={`${l.accountNumber}-${i}`}
                        className="flex items-center justify-between gap-3 rounded-md bg-slate-900/40 px-3 py-1.5"
                      >
                        <div className="min-w-0">
                          <div className="text-xs text-slate-200 truncate">
                            <span className="font-mono text-2xs text-slate-500">{l.accountNumber}</span>{' '}
                            {l.accountName}
                          </div>
                          <div className="text-2xs text-slate-500 flex items-center gap-1">
                            <Icon size={10} className={increase ? 'text-emerald-400' : 'text-red-400'} />
                            {isDebit ? 'Debit' : 'Credit'} · {increase ? 'increases' : 'decreases'} this{' '}
                            {l.accountType.toLowerCase()} account
                          </div>
                        </div>
                        <span
                          className={clsx(
                            'text-xs font-mono tabular-nums shrink-0',
                            isDebit ? 'text-emerald-400' : 'text-red-400',
                          )}
                        >
                          {formatMoney(l.amountCents)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {/* Based on — the fact list */}
            {data.explanation.facts.length > 0 && (
              <div>
                <h4 className="text-2xs text-slate-500 uppercase tracking-wider font-semibold mb-1.5">
                  Based on
                </h4>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
                  {data.explanation.facts.map((f) => (
                    <div key={f.label} className="flex items-baseline justify-between gap-2 min-w-0">
                      <dt className="text-2xs text-slate-500 shrink-0">{f.label}</dt>
                      <dd
                        className={clsx(
                          'text-xs text-slate-300 truncate text-right',
                          f.mono && 'font-mono tabular-nums',
                        )}
                      >
                        {f.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}

            {/* Automation / approval trail */}
            {(data.explanation.proposedBy || data.explanation.approvedBy) && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-slate-400">
                {data.explanation.proposedBy && (
                  <span>
                    <span className="text-slate-500">Proposed:</span> {data.explanation.proposedBy.label}
                    {data.explanation.proposedBy.detail ? ` (${data.explanation.proposedBy.detail})` : ''}
                  </span>
                )}
                {data.explanation.approvedBy && (
                  <span className="inline-flex items-center gap-1">
                    <ArrowRight size={10} className="text-slate-600" />
                    <span className="text-slate-500">Approval:</span> {data.explanation.approvedBy.label}
                    {data.explanation.approvedBy.detail ? ` (${data.explanation.approvedBy.detail})` : ''}
                  </span>
                )}
              </div>
            )}

            {/* Links to underlying records */}
            {data.explanation.links.length > 0 && (
              <div className="flex flex-wrap gap-2 pt-1">
                {data.explanation.links.map((lnk) => {
                  const external = lnk.href.startsWith('http');
                  const cls =
                    'inline-flex items-center gap-1 px-2 py-1 rounded-md text-2xs font-medium bg-slate-800/60 text-slate-300 hover:bg-slate-700/60 hover:text-slate-100 transition-colors';
                  return external ? (
                    <a key={lnk.href + lnk.label} href={lnk.href} target="_blank" rel="noopener noreferrer" className={cls}>
                      {lnk.label} <ExternalLink size={10} />
                    </a>
                  ) : (
                    <Link key={lnk.href + lnk.label} href={lnk.href} className={cls}>
                      {lnk.label} <ArrowUpRight size={10} />
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
