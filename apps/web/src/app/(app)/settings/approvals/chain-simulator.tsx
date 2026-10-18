'use client';

/**
 * ChainSimulator — a read-only "what would happen if I submit THIS document?" tool.
 *
 * The admin picks a document type and enters an amount; the UI deterministically resolves
 * which active chain applies and the EXACT ordered approver sequence that would be
 * required — using the same pure engine (`simulateChain` → `applicableSteps`) the runtime
 * uses, so the preview can't disagree with production routing. No writes, no network, no
 * AI: it computes over the already-loaded chain definitions. Entities are noted as
 * org-wide because approval chains are configured per organization (not per entity) in
 * the current model, so the resolved chain is the same regardless of entity.
 */

import { useMemo, useState } from 'react';
import { ArrowRight, PlayCircle } from 'lucide-react';
import { formatMoney, dollarsToCents } from '@meritbooks/shared';
import { ROLE_DEFINITIONS, type UserRole } from '@/lib/rbac/permissions';
import { WORKFLOW_DOC_TYPES, type WorkflowDocType } from '@/lib/approvals/workflow';
import { simulateChain, WORKFLOW_DOC_TYPE_LABEL, type AnalyzableWorkflow } from '@/lib/approvals/analysis';

function roleLabel(role: string): string {
  return ROLE_DEFINITIONS[role as UserRole]?.label ?? role;
}

export function ChainSimulator({ workflows }: { workflows: AnalyzableWorkflow[] }) {
  const [docType, setDocType] = useState<WorkflowDocType>('BILL');
  const [amount, setAmount] = useState('25000');
  const [entity, setEntity] = useState('');

  const parsed = useMemo(() => {
    const raw = amount.trim();
    if (raw === '') return { valid: false as const };
    const n = Number(raw.replace(/[,$\s]/g, ''));
    if (!Number.isFinite(n) || n < 0) return { valid: false as const };
    return { valid: true as const, cents: dollarsToCents(n) };
  }, [amount]);

  const outcome = useMemo(() => {
    if (!parsed.valid) return null;
    return simulateChain(workflows, docType, parsed.cents);
  }, [parsed, workflows, docType]);

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-white">Simulate a scenario</h2>
        <p className="mt-1 text-xs text-slate-400">
          See which chain applies and exactly who must approve — a read-only preview. Nothing
          is submitted or created.
        </p>
      </div>

      <div className="rounded-xl border border-white/5 bg-surface-900 p-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <label className="block">
            <span className="text-2xs uppercase tracking-wide text-slate-500">Document type</span>
            <select
              value={docType}
              onChange={(e) => setDocType(e.target.value as WorkflowDocType)}
              className="mt-1 w-full rounded-lg border border-white/10 bg-surface-950 px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none"
            >
              {WORKFLOW_DOC_TYPES.map((t) => (
                <option key={t} value={t}>
                  {WORKFLOW_DOC_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-2xs uppercase tracking-wide text-slate-500">Amount ($)</span>
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="25000"
              aria-invalid={!parsed.valid}
              className="mt-1 w-full rounded-lg border border-white/10 bg-surface-950 px-3 py-2 font-mono text-sm tabular-nums text-white focus:border-emerald-500 focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="text-2xs uppercase tracking-wide text-slate-500">Entity (for reference)</span>
            <input
              value={entity}
              onChange={(e) => setEntity(e.target.value)}
              placeholder="Any company"
              className="mt-1 w-full rounded-lg border border-white/10 bg-surface-950 px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none"
            />
          </label>
        </div>
        <p className="mt-2 text-2xs text-slate-500">
          Approval chains are configured per organization and apply org-wide, so the same chain
          resolves for every entity.
        </p>

        <div className="mt-5 border-t border-white/5 pt-4">
          {!parsed.valid ? (
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-xs text-amber-300">
              Enter a valid non-negative amount to preview the required approvals.
            </div>
          ) : outcome && outcome.kind === 'CHAIN' ? (
            <div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300">
                <PlayCircle className="h-4 w-4 text-emerald-400" />
                <span className="font-medium text-white">{formatMoney(parsed.cents)}</span>
                <span className="text-slate-500">{WORKFLOW_DOC_TYPE_LABEL[docType]}</span>
                <span className="text-slate-600">routes into</span>
                <span className="font-medium text-white">{outcome.workflowName}</span>
                <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-2xs text-emerald-300">
                  {outcome.sequence.length} approval{outcome.sequence.length === 1 ? '' : 's'}
                </span>
              </div>
              <ol className="mt-3 flex flex-wrap items-center gap-2">
                {outcome.sequence.map((s, i) => (
                  <li key={s.stepOrder} className="flex items-center gap-2">
                    <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2">
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/20 font-mono text-2xs text-emerald-300">
                        {i + 1}
                      </span>
                      <span className="text-xs font-medium text-white">{roleLabel(s.approverRole)}</span>
                      {s.requireDistinct && (
                        <span className="rounded bg-indigo-500/10 px-1.5 py-0.5 text-2xs text-indigo-300">
                          distinct
                        </span>
                      )}
                    </div>
                    {i < outcome.sequence.length - 1 && <ArrowRight className="h-4 w-4 text-slate-600" />}
                  </li>
                ))}
              </ol>
              <p className="mt-3 text-2xs text-slate-500">
                Each step also enforces separation of duties (the preparer can never approve) at
                money-movement time.
              </p>
            </div>
          ) : outcome && outcome.kind === 'NO_APPLICABLE_STEPS' ? (
            <div className="rounded-lg border border-white/10 bg-surface-950 px-4 py-3 text-xs text-slate-300">
              <span className="font-medium text-white">{outcome.workflowName}</span> is active, but no
              step&rsquo;s amount band covers {formatMoney(parsed.cents)}. This document would keep the
              existing single-approver behavior.
            </div>
          ) : (
            <div className="rounded-lg border border-white/10 bg-surface-950 px-4 py-3 text-xs text-slate-300">
              No active multi-step chain for {WORKFLOW_DOC_TYPE_LABEL[docType]}. This document would keep
              the existing single-approver behavior.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
