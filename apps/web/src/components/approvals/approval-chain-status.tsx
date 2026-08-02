'use client';

/**
 * ApprovalChainStatus — the approval-chain widget shown ON a document (bill, JE,
 * payment, expense, payroll). Renders the ordered steps for this document's amount,
 * who has approved, whose turn it is, and — for the caller who is authorized at the
 * current step — approve/reject controls (reject requires a reason). Reads the open
 * request via GET /api/approvals/requests?doc_type&doc_id and acts via
 * POST /api/approvals/requests/:id/act. Degrade-safe: when no workflow request exists
 * for the document, it renders nothing (the doc keeps its single-approver behavior).
 *
 * Loading / empty / error states are all handled.
 */

import { useCallback, useEffect, useState } from 'react';
import { formatMoney } from '@meritbooks/shared';
import { addToast } from '@/hooks/use-toast';
import { ROLE_DEFINITIONS, type UserRole } from '@/lib/rbac/permissions';
import type { WorkflowDocType } from '@/lib/approvals/workflow';

interface StepView {
  stepOrder: number;
  minAmountCents: number;
  maxAmountCents: number | null;
  approverRole: UserRole;
  requireDistinct: boolean;
}

interface ActionView {
  stepOrder: number;
  actorUser: string;
  decision: 'APPROVE' | 'REJECT';
  reason: string | null;
  actedAt: string;
}

interface RequestView {
  id: string;
  docType: WorkflowDocType;
  docId: string;
  amountCents: number;
  currentStep: number;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  preparedBy: string;
  steps: StepView[];
  actions: ActionView[];
}

export interface ApprovalChainStatusProps {
  docType: WorkflowDocType;
  docId: string;
  /** Optional: refresh the parent after a terminal decision. */
  onDecided?: (status: 'APPROVED' | 'REJECTED') => void;
}

export function ApprovalChainStatus({ docType, docId, onDecided }: ApprovalChainStatusProps) {
  const [request, setRequest] = useState<RequestView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/approvals/requests?doc_type=${docType}&doc_id=${docId}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? `HTTP ${res.status}`);
      const json = await res.json();
      setRequest(json.request ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load approval chain');
    } finally {
      setLoading(false);
    }
  }, [docType, docId]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (decision: 'APPROVE' | 'REJECT') => {
    if (!request) return;
    if (decision === 'REJECT' && !reason.trim()) {
      setRejecting(true);
      addToast('error', 'A reason is required to reject.');
      return;
    }
    setActing(true);
    try {
      const res = await fetch(`/api/approvals/requests/${request.id}/act`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, reason: reason.trim() || undefined }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
      if (json?.bridgeError) {
        addToast('error', `Approved, but the linked action failed: ${json.bridgeError}`);
      } else {
        addToast('success', decision === 'APPROVE' ? 'Approved.' : 'Rejected.');
      }
      setReason('');
      setRejecting(false);
      const status = json?.request?.status as 'APPROVED' | 'REJECTED' | 'PENDING' | undefined;
      if ((status === 'APPROVED' || status === 'REJECTED') && onDecided) onDecided(status);
      await load();
    } catch (e) {
      addToast('error', e instanceof Error ? e.message : 'Action failed');
    } finally {
      setActing(false);
    }
  };

  if (loading) {
    return <div className="rounded-lg border border-white/5 bg-surface-900 p-4 text-xs text-slate-500">Loading approval chain…</div>;
  }
  if (error) {
    return <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4 text-xs text-red-300">{error}</div>;
  }
  if (!request) {
    // No multi-step workflow applies to this document — nothing to render.
    return null;
  }

  const actionByStep = new Map<number, ActionView>();
  for (const a of request.actions) actionByStep.set(a.stepOrder, a);

  return (
    <div className="rounded-xl border border-white/5 bg-surface-900 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">Approval chain</h3>
        <span
          className={
            request.status === 'APPROVED'
              ? 'text-2xs font-medium text-emerald-400'
              : request.status === 'REJECTED'
              ? 'text-2xs font-medium text-red-400'
              : 'text-2xs font-medium text-amber-400'
          }
        >
          {request.status}
        </span>
      </div>
      <div className="mt-0.5 text-2xs text-slate-500">Routing {formatMoney(request.amountCents)}</div>

      <ol className="mt-3 space-y-2">
        {request.steps.map((s) => {
          const action = actionByStep.get(s.stepOrder);
          const isCurrent = request.status === 'PENDING' && s.stepOrder === request.currentStep;
          const done = !!action;
          return (
            <li
              key={s.stepOrder}
              className={`flex items-start gap-3 rounded-lg border p-2.5 ${
                isCurrent ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-white/5 bg-surface-950'
              }`}
            >
              <span
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-2xs font-mono ${
                  action?.decision === 'APPROVE'
                    ? 'bg-emerald-500/20 text-emerald-300'
                    : action?.decision === 'REJECT'
                    ? 'bg-red-500/20 text-red-300'
                    : isCurrent
                    ? 'bg-emerald-500 text-surface-950'
                    : 'bg-white/5 text-slate-500'
                }`}
              >
                {action?.decision === 'APPROVE' ? '✓' : action?.decision === 'REJECT' ? '✕' : s.stepOrder}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-white">{ROLE_DEFINITIONS[s.approverRole]?.label ?? s.approverRole}</span>
                  <span className="text-2xs text-slate-500">
                    {formatMoney(s.minAmountCents)}
                    {s.maxAmountCents === null ? '+' : `–${formatMoney(s.maxAmountCents)}`}
                  </span>
                  {s.requireDistinct && <span className="text-2xs text-indigo-300">distinct</span>}
                </div>
                {done ? (
                  <div className="mt-0.5 text-2xs text-slate-500">
                    {action!.decision === 'APPROVE' ? 'Approved' : 'Rejected'} by {action!.actorUser}
                    {action!.reason ? ` — ${action!.reason}` : ''}
                  </div>
                ) : isCurrent ? (
                  <div className="mt-0.5 text-2xs text-emerald-400">Awaiting approval</div>
                ) : (
                  <div className="mt-0.5 text-2xs text-slate-600">Pending prior steps</div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {request.status === 'PENDING' && (
        <div className="mt-3 space-y-2">
          {rejecting && (
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason for rejection (required)…"
              rows={2}
              className="w-full rounded-lg border border-white/10 bg-surface-950 px-3 py-2 text-xs text-white focus:border-red-500 focus:outline-none"
            />
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => act('APPROVE')}
              disabled={acting}
              className="rounded-lg bg-emerald-500 px-4 py-1.5 text-xs font-semibold text-surface-950 hover:bg-emerald-400 disabled:opacity-40"
            >
              {acting ? 'Working…' : 'Approve this step'}
            </button>
            <button
              type="button"
              onClick={() => (rejecting ? act('REJECT') : setRejecting(true))}
              disabled={acting}
              className="rounded-lg border border-red-500/30 px-4 py-1.5 text-xs font-medium text-red-300 hover:bg-red-500/10 disabled:opacity-40"
            >
              {rejecting ? 'Confirm reject' : 'Reject'}
            </button>
            <span className="text-2xs text-slate-600">
              You will be authorized only if your role meets step {request.currentStep} and you are not the preparer.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
