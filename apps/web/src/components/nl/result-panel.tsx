'use client';

/**
 * Unified result panel — renders whichever lane the router chose:
 *   PROCESSING → ProcessingPanel (propose→approve; nothing posts autonomously)
 *   ANALYTICAL → AnalyticalPanel (read-only cited answer via /api/nl/query)
 *   NAVIGATION → a "go there" affordance
 *   ABSTAIN    → the honest "can't do that" + nearest supported action
 * Plus a clarify banner (fail-closed: ask one question, take no action).
 */

import { useRouter } from 'next/navigation';
import { ArrowRight, HelpCircle, Compass, Ban, Info } from 'lucide-react';
import { ProcessingPanel } from './processing-panel';
import { AnalyticalPanel } from './analytical-panel';
import type { NlRouteResult } from './intent';

export function ResultPanel({ result, onDone }: { result: NlRouteResult; onDone: () => void }) {
  const router = useRouter();

  // Fail-closed clarify: a lane straddle / low confidence asks one question, acts on nothing.
  if (result.clarifyingQuestion) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-3 text-sm text-amber-200">
        <HelpCircle size={16} className="mt-0.5 shrink-0" />
        <div>
          <p className="font-medium">One quick question</p>
          <p className="mt-0.5 text-amber-100/90">{result.clarifyingQuestion}</p>
        </div>
      </div>
    );
  }

  if (result.degraded && result.lane === 'ABSTAIN') {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-slate-700 bg-slate-800/50 px-3 py-3 text-sm text-slate-300">
        <Info size={16} className="mt-0.5 shrink-0 text-amber-400" />
        <div>
          <p>{result.abstain?.reason}</p>
          {result.abstain?.suggestion && <p className="mt-1 text-slate-400">{result.abstain.suggestion}</p>}
        </div>
      </div>
    );
  }

  switch (result.lane) {
    case 'PROCESSING':
      return <ProcessingPanel description={result.processing?.description ?? ''} onPosted={onDone} />;

    case 'ANALYTICAL':
      return <AnalyticalPanel prompt={result.analytical?.prompt ?? ''} />;

    case 'NAVIGATION':
      if (result.navigation) {
        return (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-2xs uppercase tracking-wider text-emerald-400">
              <Compass size={13} /> Navigation
            </div>
            <button
              onClick={() => { router.push(result.navigation!.href); onDone(); }}
              className="inline-flex w-full items-center justify-between rounded-lg border border-slate-700 bg-slate-800/60 px-4 py-3 text-sm text-white hover:border-emerald-500/50 transition-colors"
            >
              <span>Go to <span className="font-semibold">{result.navigation.label}</span></span>
              <ArrowRight size={16} className="text-emerald-400" />
            </button>
          </div>
        );
      }
      // N2 how-to with no destination
      return (
        <div className="flex items-start gap-2 rounded-lg border border-slate-700 bg-slate-800/50 px-3 py-3 text-sm text-slate-300">
          <Compass size={16} className="mt-0.5 shrink-0 text-emerald-400" />
          <p>I can point you to the right screen — try naming it, e.g. &ldquo;open bank feed&rdquo; or &ldquo;go to invoices&rdquo;.</p>
        </div>
      );

    case 'ABSTAIN':
    default:
      return (
        <div className="flex items-start gap-2 rounded-lg border border-slate-700 bg-slate-800/50 px-3 py-3 text-sm text-slate-300">
          <Ban size={16} className="mt-0.5 shrink-0 text-slate-500" />
          <div>
            <p>{result.abstain?.reason ?? "I can't do that from the ledger."}</p>
            {result.abstain?.suggestion && <p className="mt-1 text-slate-400">{result.abstain.suggestion}</p>}
          </div>
        </div>
      );
  }
}
