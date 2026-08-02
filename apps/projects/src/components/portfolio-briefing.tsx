'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Sparkles,
  TriangleAlert,
  AlertTriangle,
  FileWarning,
  ShieldAlert,
  CircleDot,
  ArrowUpRight,
  Loader2,
} from 'lucide-react';
import {
  compactMoney,
  type BriefingFacts,
  type AttentionItem,
  type AttentionKind,
  type Severity,
} from '@/lib/portfolio/briefing';

/**
 * PortfolioBriefing — the dashboard's AI-phrased executive summary.
 *
 * Fetches GET /api/portfolio/briefing on mount. Every FIGURE it renders was
 * computed server-side in code (RLS-scoped); the Core AI gateway only phrased the
 * narrative sentences. Renders loading / error / empty / populated states without
 * ever crashing the dashboard.
 *
 * Mount as <PortfolioBriefing /> — no props.
 */

interface BriefingResponse {
  narrative: string;
  facts: BriefingFacts;
  source: 'ai' | 'deterministic';
}

type LoadState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; data: BriefingResponse };

const KIND_ICON: Record<AttentionKind, React.ComponentType<{ className?: string }>> = {
  projected_loss: TriangleAlert,
  thin_margin: AlertTriangle,
  cost_overrun: FileWarning,
  billing_gate: ShieldAlert,
  unissued_draw: CircleDot,
};

function severityColor(sev: Severity): string {
  return sev === 'critical' ? 'text-danger-fg' : sev === 'warning' ? 'text-warning-fg' : 'text-info-fg';
}
function severityRail(sev: Severity): string {
  return sev === 'critical' ? 'border-danger' : sev === 'warning' ? 'border-warning' : 'border-info';
}

export function PortfolioBriefing() {
  const [state, setState] = useState<LoadState>({ phase: 'loading' });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/portfolio/briefing', { headers: { Accept: 'application/json' } });
        if (!res.ok) {
          const detail = await res.json().catch(() => null);
          const message =
            (detail && typeof detail.error === 'string' && detail.error) || `Request failed (${res.status})`;
          if (alive) setState({ phase: 'error', message });
          return;
        }
        const data = (await res.json()) as BriefingResponse;
        if (alive) setState({ phase: 'ready', data });
      } catch (e) {
        if (alive) setState({ phase: 'error', message: e instanceof Error ? e.message : 'Network error' });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <section className="rounded-2xl border border-surface-800 bg-surface-900">
      <div className="flex items-center justify-between px-5 py-4 border-b border-surface-800">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-brand-500/10 text-brand-400">
            <Sparkles className="h-3.5 w-3.5" />
          </span>
          <h2 className="text-heading text-white">Portfolio briefing</h2>
        </div>
        {state.phase === 'ready' && (
          <span className="text-2xs uppercase tracking-[0.14em] text-slate-500">
            {state.data.source === 'ai' ? 'AI-phrased' : 'Computed'}
          </span>
        )}
      </div>

      <div className="px-5 py-4">
        {state.phase === 'loading' && <Skeleton />}
        {state.phase === 'error' && <ErrorLine message={state.message} />}
        {state.phase === 'ready' && <Ready data={state.data} />}
      </div>
    </section>
  );
}

export default PortfolioBriefing;

/* ------------------------------------------------------------------ states -- */

function Skeleton() {
  return (
    <div className="animate-pulse space-y-3" aria-busy="true" aria-label="Loading briefing">
      <div className="h-3.5 w-full rounded bg-surface-800" />
      <div className="h-3.5 w-11/12 rounded bg-surface-800" />
      <div className="h-3.5 w-3/4 rounded bg-surface-800" />
      <div className="mt-4 flex items-center gap-2 text-2xs text-slate-600">
        <Loader2 className="h-3 w-3 animate-spin" /> Computing figures from your ledger…
      </div>
    </div>
  );
}

function ErrorLine({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-danger/40 bg-danger/5 px-3 py-2.5">
      <div className="text-sm font-medium text-danger-fg">Briefing unavailable</div>
      <div className="mt-0.5 font-mono text-2xs text-slate-400">{message}</div>
    </div>
  );
}

function Ready({ data }: { data: BriefingResponse }) {
  const { narrative, facts, source } = data;

  if (facts.counts.jobs === 0) {
    return (
      <p className="text-sm leading-relaxed text-slate-400">
        No active jobs in the portfolio yet — the briefing populates once work is underway.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm leading-relaxed text-slate-200">{narrative}</p>

      <div className="text-2xs text-slate-500">
        {source === 'ai'
          ? 'AI-phrased · figures computed from your ledger'
          : 'Computed from your ledger · no model'}
      </div>

      {facts.attention.length > 0 && (
        <ul className="divide-y divide-surface-800 rounded-xl border border-surface-800 bg-surface-950/40">
          {facts.attention.map((a, i) => (
            <AttentionRow key={`${a.kind}-${i}`} item={a} />
          ))}
        </ul>
      )}
    </div>
  );
}

function AttentionRow({ item }: { item: AttentionItem }) {
  const Icon = KIND_ICON[item.kind];
  const showImpact = item.impactCents !== 0;
  return (
    <li>
      <Link
        href={item.href}
        className={`flex items-center gap-3 border-l-2 ${severityRail(item.severity)} px-4 py-2.5 hover:bg-surface-850 transition-colors`}
      >
        <Icon className={`h-4 w-4 shrink-0 ${severityColor(item.severity)}`} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm text-white">{item.label}</div>
          <div className="truncate text-2xs uppercase tracking-wider text-slate-500">{item.detail}</div>
        </div>
        {showImpact && (
          <div
            className={`font-mono text-sm tabular-nums ${item.impactCents < 0 ? 'text-danger-fg' : 'text-slate-300'}`}
          >
            {compactMoney(item.impactCents)}
          </div>
        )}
        <ArrowUpRight className="h-3.5 w-3.5 text-slate-600" />
      </Link>
    </li>
  );
}
