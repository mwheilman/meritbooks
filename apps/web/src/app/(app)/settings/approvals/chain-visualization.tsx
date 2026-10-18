'use client';

/**
 * ChainVisualization — read-only, at-a-glance picture of every configured approval chain.
 *
 * For each of the five workflow document types it shows the ACTIVE chain (if any) as an
 * amount-tier ladder: number of steps, each step's dollar band, the required approver
 * role, and the distinct-approver flag — so an admin can SEE who must approve what, and at
 * which dollar bands, without reading raw config. Clicking a chain opens an accessible
 * detail dialog (role=dialog, Esc to close) with the full ordered ladder. Purely presents
 * the `workflows` it is given; it never changes how approvals are enforced.
 */

import { useEffect, useRef, useState } from 'react';
import { GitBranch, X } from 'lucide-react';
import { formatMoney } from '@meritbooks/shared';
import { ROLE_DEFINITIONS, type UserRole } from '@/lib/rbac/permissions';
import { WORKFLOW_DOC_TYPES, type WorkflowStepDef, type WorkflowDocType } from '@/lib/approvals/workflow';
import {
  activeWorkflowFor,
  isKnownRole,
  WORKFLOW_DOC_TYPE_LABEL,
  type AnalyzableWorkflow,
} from '@/lib/approvals/analysis';

function bandLabel(s: WorkflowStepDef): string {
  return s.maxAmountCents === null
    ? `${formatMoney(s.minAmountCents)}+`
    : `${formatMoney(s.minAmountCents)} – ${formatMoney(s.maxAmountCents)}`;
}

function roleLabel(role: string): string {
  return ROLE_DEFINITIONS[role as UserRole]?.label ?? role;
}

function StepRow({ s }: { s: WorkflowStepDef }) {
  const unknown = !isKnownRole(s.approverRole);
  return (
    <li className="flex items-center gap-3 rounded-lg border border-white/5 bg-surface-950 px-3 py-2">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/5 font-mono text-2xs text-slate-400">
        {s.stepOrder}
      </span>
      <span className={`text-xs font-medium ${unknown ? 'text-red-300' : 'text-white'}`}>
        {roleLabel(s.approverRole)}
        {unknown && <span className="ml-1 text-2xs text-red-400">(unknown role)</span>}
      </span>
      <span className="ml-auto font-mono text-2xs tabular-nums text-slate-400">{bandLabel(s)}</span>
      {s.requireDistinct && (
        <span className="rounded bg-indigo-500/10 px-1.5 py-0.5 text-2xs text-indigo-300">distinct</span>
      )}
    </li>
  );
}

function ChainDetailDialog({
  docType,
  workflow,
  onClose,
}: {
  docType: WorkflowDocType;
  workflow: AnalyzableWorkflow;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const steps = [...workflow.steps].sort((a, b) => a.stepOrder - b.stepOrder);
  const titleId = 'chain-detail-title';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-lg rounded-2xl border border-white/10 bg-surface-900 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 id={titleId} className="text-sm font-semibold text-white">
              {workflow.name}
            </h3>
            <p className="mt-0.5 text-2xs text-slate-500">
              {WORKFLOW_DOC_TYPE_LABEL[docType]} · {steps.length} step{steps.length === 1 ? '' : 's'}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close chain detail"
            className="rounded-lg border border-white/10 p-1.5 text-slate-400 hover:border-white/20 hover:text-white focus:border-emerald-500 focus:outline-none"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mt-3 text-2xs text-slate-500">
          A document triggers every step whose dollar band covers its total, walked in order.
        </p>
        <ol className="mt-3 space-y-2">
          {steps.map((s) => (
            <StepRow key={s.stepOrder} s={s} />
          ))}
        </ol>
      </div>
    </div>
  );
}

export function ChainVisualization({ workflows }: { workflows: AnalyzableWorkflow[] }) {
  const [detail, setDetail] = useState<{ docType: WorkflowDocType; workflow: AnalyzableWorkflow } | null>(null);

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-white">Chains at a glance</h2>
        <p className="mt-1 text-xs text-slate-400">
          The active approval ladder for each document type. Amount bands stack — a document
          triggers every step whose band covers its total.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {WORKFLOW_DOC_TYPES.map((dt) => {
          const wf = activeWorkflowFor(workflows, dt);
          const steps = wf ? [...wf.steps].sort((a, b) => a.stepOrder - b.stepOrder) : [];
          return (
            <div key={dt} className="rounded-xl border border-white/5 bg-surface-900 p-4">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-white">{WORKFLOW_DOC_TYPE_LABEL[dt]}</div>
                  {wf ? (
                    <div className="mt-0.5 truncate text-2xs text-slate-500">
                      {wf.name} · {steps.length} step{steps.length === 1 ? '' : 's'}
                    </div>
                  ) : (
                    <div className="mt-0.5 text-2xs text-slate-600">No active chain</div>
                  )}
                </div>
                {wf ? (
                  <button
                    type="button"
                    onClick={() => setDetail({ docType: dt, workflow: wf })}
                    className="shrink-0 rounded-lg border border-white/10 px-2.5 py-1 text-2xs text-slate-300 hover:border-emerald-500/40 hover:text-white focus:border-emerald-500 focus:outline-none"
                  >
                    View detail
                  </button>
                ) : (
                  <span className="shrink-0 rounded-full bg-amber-500/10 px-2 py-0.5 text-2xs text-amber-300">
                    single-approver
                  </span>
                )}
              </div>

              {wf ? (
                <ol className="mt-3 space-y-1.5">
                  {steps.map((s) => (
                    <StepRow key={s.stepOrder} s={s} />
                  ))}
                </ol>
              ) : (
                <div className="mt-3 flex items-center gap-2 rounded-lg border border-dashed border-white/10 bg-surface-950 px-3 py-3 text-2xs text-slate-500">
                  <GitBranch className="h-3.5 w-3.5 text-slate-600" />
                  Documents of this type keep the existing single-approver behavior.
                </div>
              )}
            </div>
          );
        })}
      </div>

      {detail && (
        <ChainDetailDialog docType={detail.docType} workflow={detail.workflow} onClose={() => setDetail(null)} />
      )}
    </section>
  );
}
