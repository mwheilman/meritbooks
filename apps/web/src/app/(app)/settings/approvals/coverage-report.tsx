'use client';

/**
 * CoverageReport — deterministic detection of approval-chain gaps, so an admin can see
 * holes before they bite. Runs the pure `detectCoverageGaps()` over the loaded chains and
 * the org's active-member role counts (fetched read-only from /api/approvals/coverage) to
 * flag, per document type:
 *   - warning: no active chain (docs keep single-approver behavior);
 *   - warning: an amount band that no step covers (falls through to single-approver);
 *   - critical: a step naming an unknown role;
 *   - critical: a step whose required authority NO active member could satisfy (dead step).
 * Read-only — it changes nothing about enforcement, it just surfaces the facts.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, ShieldAlert } from 'lucide-react';
import { detectCoverageGaps, type CoverageFinding, type AnalyzableWorkflow } from '@/lib/approvals/analysis';

const SEVERITY_STYLE: Record<CoverageFinding['severity'], { ring: string; text: string; icon: typeof AlertTriangle }> = {
  critical: { ring: 'border-red-500/30 bg-red-500/5', text: 'text-red-300', icon: ShieldAlert },
  warning: { ring: 'border-amber-500/25 bg-amber-500/5', text: 'text-amber-300', icon: AlertTriangle },
};

export function CoverageReport({ workflows }: { workflows: AnalyzableWorkflow[] }) {
  const [activeRoleCounts, setActiveRoleCounts] = useState<Record<string, number> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/approvals/coverage');
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? `HTTP ${res.status}`);
      const json = await res.json();
      setActiveRoleCounts((json.activeRoleCounts as Record<string, number>) ?? {});
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load member coverage');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const findings = useMemo(
    () =>
      detectCoverageGaps(workflows, {
        activeRoleCounts: activeRoleCounts ?? undefined,
      }),
    [workflows, activeRoleCounts]
  );

  const criticals = findings.filter((f) => f.severity === 'critical');
  const warnings = findings.filter((f) => f.severity === 'warning');

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-white">Coverage gaps</h2>
        <p className="mt-1 text-xs text-slate-400">
          Document types and amount bands with no approval rule, or rules that reference a role
          no active member can fill. Critical gaps can strand a document with no valid approver.
        </p>
      </div>

      {loading ? (
        <div className="rounded-lg border border-white/5 bg-surface-900 p-4 text-xs text-slate-500">
          Analyzing coverage…
        </div>
      ) : error ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-red-500/20 bg-red-500/5 p-4 text-xs text-red-300">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-lg border border-red-500/30 px-3 py-1 text-2xs text-red-200 hover:bg-red-500/10"
          >
            Retry
          </button>
        </div>
      ) : findings.length === 0 ? (
        <div className="flex items-center gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-5 text-xs text-emerald-300">
          <CheckCircle2 className="h-5 w-5" />
          <div>
            <div className="font-medium text-white">No coverage gaps detected.</div>
            <div className="mt-0.5 text-2xs text-emerald-200/80">
              Every document type has an active chain covering all amounts, and every step names a
              role at least one active member can satisfy.
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-3 text-2xs">
            <span className="rounded-full bg-red-500/10 px-3 py-1 tabular-nums text-red-300">
              {criticals.length} critical
            </span>
            <span className="rounded-full bg-amber-500/10 px-3 py-1 tabular-nums text-amber-300">
              {warnings.length} warning{warnings.length === 1 ? '' : 's'}
            </span>
            {activeRoleCounts && Object.keys(activeRoleCounts).length === 0 && (
              <span className="rounded-full bg-white/5 px-3 py-1 text-slate-500">
                No active members resolved — satisfiability checks skipped
              </span>
            )}
          </div>

          <ul className="space-y-2">
            {[...criticals, ...warnings].map((f, i) => {
              const style = SEVERITY_STYLE[f.severity];
              const Icon = style.icon;
              return (
                <li
                  key={`${f.docType}-${f.code}-${f.stepOrder ?? f.bandFromCents ?? i}`}
                  className={`flex items-start gap-3 rounded-lg border p-3 ${style.ring}`}
                >
                  <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${style.text}`} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-white">{f.docTypeLabel}</span>
                      <span className={`text-2xs uppercase tracking-wide ${style.text}`}>
                        {f.severity}
                      </span>
                    </div>
                    <p className="mt-0.5 text-2xs text-slate-300">{f.message}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
