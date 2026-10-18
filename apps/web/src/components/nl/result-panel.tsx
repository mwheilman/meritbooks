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
import { ArrowRight, HelpCircle, Compass, Ban } from 'lucide-react';
import { ProcessingPanel } from './processing-panel';
import { CategorizePanel } from './categorize-panel';
import { BillDraftPanel } from './bill-draft-panel';
import { InvoiceDraftPanel } from './invoice-draft-panel';
import { AnalyticalPanel } from './analytical-panel';
import { AiUnavailableNotice } from '@/components/ai/ai-unavailable-notice';
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

  // AI was unavailable (org disabled / budget cap / no key) and the rules fallback
  // had nothing safe to do → calm paused notice, never a red error. When the rules
  // DID resolve a lane (e.g. navigation still works), we fall through and render it.
  if (result.degraded && result.lane === 'ABSTAIN') {
    return (
      <AiUnavailableNotice
        message={result.abstain?.reason ?? 'AI is temporarily unavailable — try again later.'}
        hint={result.abstain?.suggestion ?? undefined}
      />
    );
  }

  switch (result.lane) {
    case 'PROCESSING': {
      // Each processing intent drives its own propose→approve panel, and each
      // panel reuses an EXISTING gated route (no parallel posting path).
      const kind = result.processing?.kind ?? 'P1_RECORD_JE';
      const description = result.processing?.description ?? '';
      switch (kind) {
        case 'P2_CATEGORIZE':
          return <CategorizePanel prompt={description} onDone={onDone} />;
        case 'P3_CREATE_BILL':
          return <BillDraftPanel description={description} onDone={onDone} />;
        case 'P4_CREATE_INVOICE':
          return <InvoiceDraftPanel description={description} onDone={onDone} />;
        case 'P1_RECORD_JE':
        default:
          return <ProcessingPanel description={description} onPosted={onDone} />;
      }
    }

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
