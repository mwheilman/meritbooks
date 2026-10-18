'use client';

/**
 * ANALYTICAL lane — forwards the prompt to POST /api/nl/query (the constrained,
 * allowlisted, read-only ledger-query endpoint built in parallel) and renders the
 * cited answer + drill-down. This lane MUTATES NOTHING.
 *
 * Contract coded against (agreed with the /api/nl/query builder):
 *   request:  { prompt: string }
 *   response: {
 *     answer: string,
 *     metric: string,
 *     params: Record<string, unknown>,
 *     rows: Array<Record<string, unknown>>,
 *     citations: Array<{ label: string, href: string }>,
 *     drilldownHref?: string
 *   }
 *
 * The endpoint may not exist yet (built by another agent). If it 404s at runtime
 * we degrade to an "analytical engine initializing" state rather than crashing.
 */

import { useEffect, useState } from 'react';
import { Loader2, BarChart3, ExternalLink, Clock, AlertTriangle } from 'lucide-react';
import Link from 'next/link';
import { AiUnavailableNotice } from '@/components/ai/ai-unavailable-notice';

interface Citation { label: string; href: string }
interface QueryResponse {
  answer: string;
  metric?: string;
  params?: Record<string, unknown>;
  rows?: Array<Record<string, unknown>>;
  citations?: Citation[];
  drilldownHref?: string;
  unavailable?: boolean;
  message?: string;
}

type State =
  | { kind: 'loading' }
  | { kind: 'ok'; data: QueryResponse }
  | { kind: 'initializing' } // endpoint not deployed yet (404)
  | { kind: 'unavailable'; message: string } // AI paused (org disabled / budget / no key)
  | { kind: 'error'; message: string };

export function AnalyticalPanel({ prompt }: { prompt: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let alive = true;
    setState({ kind: 'loading' });
    (async () => {
      try {
        const res = await fetch('/api/nl/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt }),
        });
        if (res.status === 404) { if (alive) setState({ kind: 'initializing' }); return; }
        const data = await res.json().catch(() => null);
        // AI paused (org disabled / budget cap / no key). Returned as HTTP 200 with
        // an `unavailable` flag so we render the calm notice, not a red error.
        if (data && data.unavailable) {
          if (alive) setState({ kind: 'unavailable', message: data.message ?? 'AI is temporarily unavailable — try again later.' });
          return;
        }
        if (!res.ok) {
          if (alive) setState({ kind: 'error', message: data?.error ?? 'The analytical engine could not answer that.' });
          return;
        }
        if (!data || typeof data.answer !== 'string') {
          if (alive) setState({ kind: 'initializing' });
          return;
        }
        if (alive) setState({ kind: 'ok', data: data as QueryResponse });
      } catch {
        if (alive) setState({ kind: 'initializing' });
      }
    })();
    return () => { alive = false; };
  }, [prompt]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-2xs uppercase tracking-wider text-indigo-300">
        <BarChart3 size={13} /> Analytical · read-only ledger query
      </div>

      {state.kind === 'loading' && (
        <div className="flex items-center gap-2 text-sm text-slate-400">
          <Loader2 size={15} className="animate-spin" /> Querying the ledger…
        </div>
      )}

      {state.kind === 'initializing' && (
        <div className="flex items-start gap-2 rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-3 py-2 text-sm text-indigo-200">
          <Clock size={15} className="mt-0.5 shrink-0" />
          <span>The analytical engine is initializing. Ledger Q&amp;A will answer here once it&rsquo;s live — your question was routed correctly.</span>
        </div>
      )}

      {state.kind === 'unavailable' && (
        <AiUnavailableNotice
          message={state.message}
          hint="Open the numbers directly from the Reports page in the meantime."
        />
      )}

      {state.kind === 'error' && (
        <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span>{state.message}</span>
        </div>
      )}

      {state.kind === 'ok' && (
        <div className="space-y-3">
          <p className="text-sm leading-relaxed text-slate-100 whitespace-pre-wrap">{state.data.answer}</p>

          {Array.isArray(state.data.rows) && state.data.rows.length > 0 && (
            <div className="rounded-xl border border-slate-800 overflow-hidden overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-800/60 text-2xs uppercase tracking-wider text-slate-500">
                    {Object.keys(state.data.rows[0]).map((k) => (
                      <th key={k} className="px-3 py-2 text-left font-medium">{k}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {state.data.rows.slice(0, 12).map((row, i) => (
                    <tr key={i} className="border-t border-slate-800">
                      {Object.values(row).map((v, j) => (
                        <td key={j} className="px-3 py-1.5 text-slate-300 font-mono">{v == null ? '—' : String(v)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {Array.isArray(state.data.citations) && state.data.citations.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-2xs uppercase tracking-wider text-slate-500">Cited from</span>
              {state.data.citations.map((c, i) => (
                <Link key={i} href={c.href}
                  className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-800/60 px-2.5 py-1 text-xs text-slate-300 hover:border-emerald-500/50 hover:text-white transition-colors">
                  {c.label} <ExternalLink size={11} />
                </Link>
              ))}
            </div>
          )}

          {state.data.drilldownHref && (
            <Link href={state.data.drilldownHref}
              className="inline-flex items-center gap-1.5 text-sm text-emerald-400 hover:text-emerald-300">
              Drill into the source rows <ExternalLink size={13} />
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
