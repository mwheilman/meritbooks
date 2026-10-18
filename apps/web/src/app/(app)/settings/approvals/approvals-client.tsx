'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { GitBranch } from 'lucide-react';
import { formatMoney } from '@meritbooks/shared';
import { addToast } from '@/hooks/use-toast';
import { EmptyState, StatusBadge } from '@/components/ui';
import { ALL_ROLES, ROLE_DEFINITIONS, type UserRole } from '@/lib/rbac/permissions';
import { WORKFLOW_DOC_TYPES, type WorkflowDocType } from '@/lib/approvals/workflow';
import { ChainVisualization } from './chain-visualization';
import { ChainSimulator } from './chain-simulator';
import { CoverageReport } from './coverage-report';

type ApprovalsTab = 'configure' | 'visualize' | 'simulate' | 'coverage';

const TABS: Array<{ id: ApprovalsTab; label: string }> = [
  { id: 'configure', label: 'Configure' },
  { id: 'visualize', label: 'Visualize' },
  { id: 'simulate', label: 'Simulate' },
  { id: 'coverage', label: 'Coverage gaps' },
];

interface StepForm {
  stepOrder: number;
  minDollars: string;
  maxDollars: string; // '' = no ceiling
  approverRole: UserRole;
  requireDistinct: boolean;
}

interface WorkflowView {
  id: string;
  docType: WorkflowDocType;
  name: string;
  active: boolean;
  description: string | null;
  steps: Array<{
    stepOrder: number;
    minAmountCents: number;
    maxAmountCents: number | null;
    approverRole: UserRole;
    requireDistinct: boolean;
  }>;
}

const DOC_TYPE_LABEL: Record<WorkflowDocType, string> = {
  BILL: 'Bill / AP',
  JOURNAL_ENTRY: 'Journal entry',
  PAYMENT: 'Payment / money movement',
  EXPENSE: 'Expense report',
  PAYROLL: 'Payroll run',
};

// Roles that make sense as approvers (exclude the external business user).
const APPROVER_ROLES: UserRole[] = ALL_ROLES.filter((r) => r !== 'business_user');

function newStep(order: number): StepForm {
  return { stepOrder: order, minDollars: '0', maxDollars: '', approverRole: 'accounting_manager', requireDistinct: true };
}

export function ApprovalWorkflowsClient() {
  const [workflows, setWorkflows] = useState<WorkflowView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<ApprovalsTab>('configure');

  // Builder form state
  const [name, setName] = useState('Approval chain');
  const [docType, setDocType] = useState<WorkflowDocType>('BILL');
  const [steps, setSteps] = useState<StepForm[]>([newStep(1)]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/approvals/workflows');
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? `HTTP ${res.status}`);
      const json = await res.json();
      setWorkflows(json.workflows ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load workflows');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const addStep = () => setSteps((s) => [...s, newStep((s[s.length - 1]?.stepOrder ?? 0) + 1)]);
  const removeStep = (i: number) => setSteps((s) => s.filter((_, idx) => idx !== i).map((st, idx) => ({ ...st, stepOrder: idx + 1 })));
  const patchStep = (i: number, patch: Partial<StepForm>) =>
    setSteps((s) => s.map((st, idx) => (idx === i ? { ...st, ...patch } : st)));

  const formErrors = useMemo(() => {
    const errs: string[] = [];
    if (!name.trim()) errs.push('Name is required.');
    if (steps.length === 0) errs.push('Add at least one step.');
    steps.forEach((st) => {
      const min = Number(st.minDollars);
      if (!Number.isFinite(min) || min < 0) errs.push(`Step ${st.stepOrder}: minimum must be a non-negative number.`);
      if (st.maxDollars.trim() !== '') {
        const max = Number(st.maxDollars);
        if (!Number.isFinite(max) || max < 0) errs.push(`Step ${st.stepOrder}: maximum must be a non-negative number or blank.`);
        else if (max < min) errs.push(`Step ${st.stepOrder}: maximum is below minimum.`);
      }
    });
    return errs;
  }, [name, steps]);

  const submit = async () => {
    if (formErrors.length > 0) {
      addToast('error', formErrors[0]);
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        docType,
        steps: steps.map((st) => ({
          stepOrder: st.stepOrder,
          minAmountCents: Math.round(Number(st.minDollars) * 100),
          maxAmountCents: st.maxDollars.trim() === '' ? null : Math.round(Number(st.maxDollars) * 100),
          approverRole: st.approverRole,
          requireDistinct: st.requireDistinct,
        })),
      };
      const res = await fetch('/api/approvals/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(Array.isArray(j?.details) ? j.details.join('; ') : j?.error ?? `HTTP ${res.status}`);
      }
      addToast('success', 'Workflow saved and activated.');
      setName('Approval chain');
      setSteps([newStep(1)]);
      await load();
    } catch (e) {
      addToast('error', e instanceof Error ? e.message : 'Failed to save workflow');
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (wf: WorkflowView) => {
    try {
      const res = await fetch(`/api/approvals/workflows/${wf.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: !wf.active }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? `HTTP ${res.status}`);
      addToast('success', wf.active ? 'Workflow deactivated.' : 'Workflow activated.');
      await load();
    } catch (e) {
      addToast('error', e instanceof Error ? e.message : 'Failed to update workflow');
    }
  };

  return (
    <div className="space-y-6">
      {/* View tabs — deepen the admin experience without changing enforcement. */}
      <div role="tablist" aria-label="Approval workflow views" className="flex flex-wrap gap-1 border-b border-white/5">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px rounded-t-lg border-b-2 px-3.5 py-2 text-xs font-medium focus:outline-none ${
              tab === t.id
                ? 'border-emerald-500 text-white'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab !== 'configure' && loading && (
        <div className="rounded-lg border border-white/5 bg-surface-900 p-4 text-xs text-slate-500">
          Loading workflows…
        </div>
      )}
      {tab !== 'configure' && !loading && error && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4 text-xs text-red-300">{error}</div>
      )}
      {tab === 'visualize' && !loading && !error && <ChainVisualization workflows={workflows} />}
      {tab === 'simulate' && !loading && !error && <ChainSimulator workflows={workflows} />}
      {tab === 'coverage' && !loading && !error && <CoverageReport workflows={workflows} />}

      {tab === 'configure' && (
        <div className="space-y-8">
      {/* Builder */}
      <section className="rounded-xl border border-white/5 bg-surface-900 p-5">
        <h2 className="text-sm font-semibold text-white">Define a workflow</h2>
        <p className="mt-1 text-xs text-slate-400">
          Steps stack by amount: a document triggers every step whose band covers its total, walked in order. Example: a
          manager on all bills, a controller on $10k+, a CFO on $50k+.
        </p>

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="text-2xs uppercase tracking-wide text-slate-500">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded-lg border border-white/10 bg-surface-950 px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none"
              placeholder="AP approval chain"
            />
          </label>
          <label className="block">
            <span className="text-2xs uppercase tracking-wide text-slate-500">Document type</span>
            <select
              value={docType}
              onChange={(e) => setDocType(e.target.value as WorkflowDocType)}
              className="mt-1 w-full rounded-lg border border-white/10 bg-surface-950 px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none"
            >
              {WORKFLOW_DOC_TYPES.map((t) => (
                <option key={t} value={t}>{DOC_TYPE_LABEL[t]}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="mt-5 space-y-3">
          {steps.map((st, i) => (
            <div key={i} className="rounded-lg border border-white/5 bg-surface-950 p-3">
              <div className="flex items-center justify-between">
                <span className="font-mono text-2xs text-slate-500">STEP {st.stepOrder}</span>
                {steps.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeStep(i)}
                    className="text-2xs text-slate-500 hover:text-red-400"
                  >
                    Remove
                  </button>
                )}
              </div>
              <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <label className="block">
                  <span className="text-2xs text-slate-500">Min $</span>
                  <input
                    inputMode="decimal"
                    value={st.minDollars}
                    onChange={(e) => patchStep(i, { minDollars: e.target.value })}
                    className="mt-1 w-full rounded-md border border-white/10 bg-surface-900 px-2 py-1.5 font-mono text-sm text-white focus:border-emerald-500 focus:outline-none"
                  />
                </label>
                <label className="block">
                  <span className="text-2xs text-slate-500">Max $ (blank = no cap)</span>
                  <input
                    inputMode="decimal"
                    value={st.maxDollars}
                    onChange={(e) => patchStep(i, { maxDollars: e.target.value })}
                    placeholder="—"
                    className="mt-1 w-full rounded-md border border-white/10 bg-surface-900 px-2 py-1.5 font-mono text-sm text-white focus:border-emerald-500 focus:outline-none"
                  />
                </label>
                <label className="block">
                  <span className="text-2xs text-slate-500">Approver role</span>
                  <select
                    value={st.approverRole}
                    onChange={(e) => patchStep(i, { approverRole: e.target.value as UserRole })}
                    className="mt-1 w-full rounded-md border border-white/10 bg-surface-900 px-2 py-1.5 text-sm text-white focus:border-emerald-500 focus:outline-none"
                  >
                    {APPROVER_ROLES.map((r) => (
                      <option key={r} value={r}>{ROLE_DEFINITIONS[r].label}</option>
                    ))}
                  </select>
                </label>
                <label className="flex items-end gap-2 pb-1.5">
                  <input
                    type="checkbox"
                    checked={st.requireDistinct}
                    onChange={(e) => patchStep(i, { requireDistinct: e.target.checked })}
                    className="h-4 w-4 rounded border-white/20 bg-surface-900 text-emerald-500"
                  />
                  <span className="text-2xs text-slate-400">Distinct approver</span>
                </label>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={addStep}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-300 hover:border-emerald-500/40 hover:text-white"
          >
            + Add step
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving || formErrors.length > 0}
            className="rounded-lg bg-emerald-500 px-4 py-1.5 text-xs font-semibold text-surface-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? 'Saving…' : 'Save & activate'}
          </button>
          {formErrors.length > 0 && <span className="text-2xs text-amber-400">{formErrors[0]}</span>}
        </div>
      </section>

      {/* Existing workflows */}
      <section>
        <h2 className="mb-3 text-sm font-semibold text-white">Configured workflows</h2>
        {loading ? (
          <div className="text-xs text-slate-500">Loading…</div>
        ) : error ? (
          <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4 text-xs text-red-300">{error}</div>
        ) : workflows.length === 0 ? (
          <EmptyState icon={GitBranch} title="No workflows yet" description="Documents fall back to single-approver behavior until you define a chain above." />
        ) : (
          <div className="space-y-3">
            {workflows.map((wf) => (
              <div key={wf.id} className="rounded-xl border border-white/5 bg-surface-900 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-white">{wf.name}</span>
                      <StatusBadge status={wf.active ? 'ACTIVE' : 'DRAFT'} />
                    </div>
                    <div className="mt-0.5 text-2xs text-slate-500">{DOC_TYPE_LABEL[wf.docType]}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => toggleActive(wf)}
                    className="rounded-lg border border-white/10 px-3 py-1.5 text-2xs text-slate-300 hover:border-emerald-500/40 hover:text-white"
                  >
                    {wf.active ? 'Deactivate' : 'Activate'}
                  </button>
                </div>
                <ol className="mt-3 space-y-1.5">
                  {wf.steps.map((s) => (
                    <li key={s.stepOrder} className="flex items-center gap-3 text-xs text-slate-300">
                      <span className="font-mono text-2xs text-slate-500">#{s.stepOrder}</span>
                      <span className="font-medium text-white">{ROLE_DEFINITIONS[s.approverRole]?.label ?? s.approverRole}</span>
                      <span className="text-slate-500">
                        {formatMoney(s.minAmountCents)}
                        {s.maxAmountCents === null ? '+' : `–${formatMoney(s.maxAmountCents)}`}
                      </span>
                      {s.requireDistinct && <span className="text-2xs text-indigo-300">distinct</span>}
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
        )}
      </section>
        </div>
      )}
    </div>
  );
}
