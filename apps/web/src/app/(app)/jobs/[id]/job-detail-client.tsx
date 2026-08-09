'use client';

import { useState, useCallback } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Loader2, AlertCircle, Briefcase, TrendingUp, TrendingDown, Clock, Inbox, Percent, Save,
} from 'lucide-react';
import { clsx } from 'clsx';
import { StatusBadge } from '@/components/ui';
import { formatMoney } from '@meritbooks/shared';
import { useQuery, addToast } from '@/hooks';
import { EntityInvoiceSettings } from '@/components/entity-invoice-settings';
import { InvoiceTextOverrides } from '@/components/invoice-text-overrides';
import { JobCostEacPanel } from './jobcost-eac-panel';
import { JobPLStatement } from './job-pl-statement';

const REV_REC_METHOD_OPTS: { value: string; label: string }[] = [
  { value: 'PCT_COMPLETE', label: 'POC — physical % complete' },
  { value: 'PCT_COSTS_INCURRED', label: 'POC — cost-to-cost' },
  { value: 'COMPLETED_CONTRACT', label: 'Completed contract' },
  { value: 'MILESTONE', label: 'Milestone / point-in-time' },
  { value: 'POINT_OF_SALE', label: 'Point of sale' },
  { value: 'AS_BILLED', label: 'Billing-based' },
  { value: 'RATABLY', label: 'Straight-line / ratable' },
  { value: 'SUBSCRIPTION', label: 'Subscription (ratable)' },
  { value: 'CASH', label: 'Cash' },
];

interface Category { key: string; label: string; budget: number; actual: number; variance: number; pctUsed: number | null }
interface LedgerRow { id: string; entry_date: string; description: string | null; amount_cents: number; source: string; entry_number: string | null }
interface ChangeOrder { id: string; co_number: string | null; description: string | null; amount_cents: number; status: string; created_at: string }

interface JobDetail {
  job: {
    id: string; job_number: string; name: string; description: string | null; customer_name: string | null;
    status: string; archetype: string | null; pricing_model: string | null; project_manager: string | null;
    job_site_city: string | null; job_site_state: string | null; external_source: string | null;
    start_date: string | null; estimated_completion_date: string | null;
    contract_amount_cents: number | null; estimated_cost_cents: number | null; pct_complete: number | null;
    rev_rec_method: string | null; rev_rec_method_override: string | null;
    revenue_recognized_cents: number | null; rev_rec_last_run_on: string | null;
    location: { id: string; name: string; short_code: string } | null;
  };
  metrics: {
    estimatedRevenueCents: number; estimatedCostCents: number; budgetTotalCents: number; actualCostCents: number;
    committedCents: number; clearedCents: number; remainingBudgetCents: number; pctComplete: number;
    pctBudgetUsed: number | null; earnedCents: number; billedCents: number; wipVarianceCents: number;
    grossProfitCents: number; grossMarginPct: number | null; isOverBudget: boolean;
  };
  categories: Category[];
  costByType: Record<string, { committed: number; cleared: number }>;
  ledger: LedgerRow[];
  changeOrders: ChangeOrder[];
  phases: { id: string; name: string; phase_order: number }[];
}

function Metric({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'good' | 'bad' | 'warn' }) {
  return (
    <div className="card p-4">
      <p className="text-2xs uppercase tracking-wider text-slate-500 font-semibold">{label}</p>
      <p className={clsx('text-lg font-mono font-semibold mt-1',
        tone === 'good' ? 'text-emerald-400' : tone === 'bad' ? 'text-red-400' : tone === 'warn' ? 'text-amber-400' : 'text-white')}>
        {value}
      </p>
      {sub && <p className="text-2xs text-slate-500 mt-0.5">{sub}</p>}
    </div>
  );
}

export function JobDetailClient({ jobId }: { jobId: string }) {
  const { data, isLoading, error, refetch } = useQuery<JobDetail>(`/api/jobs/${jobId}`);

  if (isLoading) return <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 text-emerald-400 animate-spin" /></div>;
  if (error || !data) {
    return (
      <div className="space-y-4">
        <Link href="/jobs" className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-white"><ArrowLeft size={14} /> Jobs</Link>
        <div className="card p-8 text-center"><AlertCircle size={24} className="mx-auto text-red-400 mb-2" /><p className="text-sm text-red-400">{error ?? 'Job not found'}</p></div>
      </div>
    );
  }

  const { job, metrics: m, categories, ledger, changeOrders } = data;
  const committedPlusActual = m.actualCostCents + m.committedCents;

  return (
    <div className="space-y-6">
      <Link href="/jobs" className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-white"><ArrowLeft size={14} /> Jobs</Link>

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <Briefcase size={18} className="text-brand-400" />
            <span className="text-sm font-mono text-slate-500">{job.job_number}</span>
            <h1 className="text-xl font-semibold text-white">{job.name}</h1>
            <StatusBadge status={job.status} />
            {job.external_source && <span className="text-2xs font-mono text-slate-500 bg-slate-800 px-1.5 py-0.5 rounded">via {job.external_source}</span>}
          </div>
          <p className="text-sm text-slate-500 mt-1">
            {[job.customer_name, job.location?.name, job.project_manager && `PM: ${job.project_manager}`,
              (job.job_site_city || job.job_site_state) && [job.job_site_city, job.job_site_state].filter(Boolean).join(', ')]
              .filter(Boolean).join('  ·  ')}
          </p>
        </div>
        <div className="text-right">
          <p className="text-2xs uppercase tracking-wider text-slate-500">% Complete</p>
          <p className="text-2xl font-mono font-semibold text-white">{m.pctComplete}%</p>
        </div>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <Metric label="Est. Revenue" value={formatMoney(m.estimatedRevenueCents)} />
        <Metric label="Est. Cost" value={formatMoney(m.estimatedCostCents)} />
        <Metric label="Actual Cost" value={formatMoney(m.actualCostCents)} tone={m.isOverBudget ? 'bad' : undefined}
          sub={m.pctBudgetUsed != null ? `${m.pctBudgetUsed}% of budget` : undefined} />
        <Metric label="Remaining Budget" value={formatMoney(m.remainingBudgetCents)} tone={m.remainingBudgetCents < 0 ? 'bad' : 'good'} />
        <Metric label="Gross Margin" value={m.grossMarginPct != null ? `${m.grossMarginPct}%` : '--'}
          sub={formatMoney(m.grossProfitCents)} tone={m.grossProfitCents < 0 ? 'bad' : 'good'} />
        <Metric label="WIP Variance" value={formatMoney(m.wipVarianceCents)}
          sub={m.wipVarianceCents > 0 ? 'Overbilled' : m.wipVarianceCents < 0 ? 'Underbilled' : 'On track'}
          tone={Math.abs(m.wipVarianceCents) < 1000 ? 'good' : 'warn'} />
      </div>

      {/* Committed vs actual (seam) */}
      {(m.committedCents > 0 || m.clearedCents > 0) && (
        <div className="card p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-white">Cost Pipeline</h2>
            <span className="text-2xs text-slate-500">committed costs awaiting bill approval clear into actuals</span>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <p className="text-2xs uppercase tracking-wider text-amber-400 font-semibold flex items-center gap-1"><Clock size={11} /> Committed</p>
              <p className="text-lg font-mono text-amber-300 mt-1">{formatMoney(m.committedCents)}</p>
              <p className="text-2xs text-slate-500">pending approval</p>
            </div>
            <div>
              <p className="text-2xs uppercase tracking-wider text-emerald-400 font-semibold">Cleared</p>
              <p className="text-lg font-mono text-emerald-300 mt-1">{formatMoney(m.clearedCents)}</p>
              <p className="text-2xs text-slate-500">posted &amp; approved</p>
            </div>
            <div>
              <p className="text-2xs uppercase tracking-wider text-slate-400 font-semibold">Committed + Actual</p>
              <p className={clsx('text-lg font-mono mt-1', committedPlusActual > m.estimatedCostCents ? 'text-red-400' : 'text-white')}>{formatMoney(committedPlusActual)}</p>
              <p className="text-2xs text-slate-500">vs {formatMoney(m.estimatedCostCents)} budget</p>
            </div>
          </div>
        </div>
      )}

      {/* Per-job P&L statement (POC; ties to the GL) */}
      <JobPLStatement jobId={job.id} />

      {/* Cost-to-complete / EAC forecast (deterministic; AI phrases only) */}
      <JobCostEacPanel jobId={job.id} />

      {/* Recognition inputs (standalone direct entry / pinned snapshot) */}
      <RevRecInputs job={job} onSaved={refetch} />

      <div className="card p-4 space-y-4">
        <h2 className="text-sm font-semibold text-white">Invoice settings &amp; text — this job</h2>
        <EntityInvoiceSettings scope="JOB" id={job.id} />
        <div className="pt-3 border-t border-slate-800">
          <InvoiceTextOverrides scope="JOB" refId={job.id} />
        </div>
      </div>

      {/* Budget vs actual by category */}
      <div className="card overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-800"><h2 className="text-sm font-semibold text-white">Budget vs Actual by Category</h2></div>
        <div className="overflow-x-auto">
        <table className="w-full min-w-[640px]">
          <thead>
            <tr className="border-b border-slate-800">
              <th className="px-4 py-2 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Category</th>
              <th className="px-4 py-2 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Budget</th>
              <th className="px-4 py-2 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Actual</th>
              <th className="px-4 py-2 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Variance</th>
              <th className="px-4 py-2 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500 w-40">Used</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/30">
            {categories.map((c) => {
              const over = c.variance < 0;
              const pct = c.pctUsed ?? 0;
              return (
                <tr key={c.key} className="table-row-hover">
                  <td className="px-4 py-2.5 text-sm text-slate-200">{c.label}</td>
                  <td className="px-4 py-2.5 text-right text-sm font-mono text-slate-300">{formatMoney(c.budget)}</td>
                  <td className="px-4 py-2.5 text-right text-sm font-mono text-slate-300">{formatMoney(c.actual)}</td>
                  <td className={clsx('px-4 py-2.5 text-right text-sm font-mono', over ? 'text-red-400' : 'text-emerald-400')}>
                    {over ? <TrendingDown size={11} className="inline mr-1" /> : <TrendingUp size={11} className="inline mr-1" />}
                    {formatMoney(Math.abs(c.variance))}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-1.5 rounded-full bg-slate-800 overflow-hidden">
                        <div className={clsx('h-full rounded-full', over ? 'bg-red-400' : pct > 85 ? 'bg-amber-400' : 'bg-emerald-400')}
                          style={{ width: `${Math.min(100, pct)}%` }} />
                      </div>
                      <span className="text-2xs font-mono text-slate-500 w-10 text-right">{c.pctUsed != null ? `${pct}%` : '--'}</span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      </div>

      {/* Change orders */}
      {changeOrders.length > 0 && (
        <div className="card p-4">
          <h2 className="text-sm font-semibold text-white mb-3">Change Orders</h2>
          <div className="space-y-1.5">
            {changeOrders.map((co) => (
              <div key={co.id} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-slate-800/30">
                <span className="text-2xs font-mono text-slate-500">{co.co_number ?? '--'}</span>
                <span className="flex-1 text-sm text-slate-300 truncate">{co.description ?? '--'}</span>
                <StatusBadge status={co.status} />
                <span className="text-sm font-mono text-slate-200">{formatMoney(co.amount_cents)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Cost ledger */}
      <div className="card overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-800"><h2 className="text-sm font-semibold text-white">Cost Ledger</h2></div>
        {ledger.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500"><Inbox size={20} className="mx-auto mb-2 text-slate-600" />No costs posted to this job yet.</div>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full min-w-[720px]">
            <thead>
              <tr className="border-b border-slate-800">
                <th className="px-4 py-2 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Date</th>
                <th className="px-4 py-2 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Source</th>
                <th className="px-4 py-2 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Description</th>
                <th className="px-4 py-2 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Entry #</th>
                <th className="px-4 py-2 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/30">
              {ledger.map((row) => (
                <tr key={row.id} className="table-row-hover">
                  <td className="px-4 py-2 text-sm font-mono text-slate-400 whitespace-nowrap">{row.entry_date}</td>
                  <td className="px-4 py-2 text-2xs"><span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">{row.source}</span></td>
                  <td className="px-4 py-2 text-sm text-slate-300 truncate max-w-[280px]">{row.description ?? '--'}</td>
                  <td className="px-4 py-2 text-2xs font-mono text-slate-500">{row.entry_number ?? '--'}</td>
                  <td className="px-4 py-2 text-right text-sm font-mono text-slate-200">{formatMoney(row.amount_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  );
}

function RevRecInputs({ job, onSaved }: { job: JobDetail['job']; onSaved: () => void }) {
  const [contract, setContract] = useState(((job.contract_amount_cents ?? 0) / 100).toString());
  const [estimate, setEstimate] = useState(((job.estimated_cost_cents ?? 0) / 100).toString());
  const [pct, setPct] = useState((job.pct_complete ?? 0).toString());
  const [override, setOverride] = useState(job.rev_rec_method_override ?? '');
  const [saving, setSaving] = useState(false);

  const dirty =
    Math.round(parseFloat(contract || '0') * 100) !== (job.contract_amount_cents ?? 0) ||
    Math.round(parseFloat(estimate || '0') * 100) !== (job.estimated_cost_cents ?? 0) ||
    parseFloat(pct || '0') !== (job.pct_complete ?? 0) ||
    (override || null) !== (job.rev_rec_method_override ?? null);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const body = {
        contract_amount_cents: Math.round(parseFloat(contract || '0') * 100),
        estimated_cost_cents: Math.round(parseFloat(estimate || '0') * 100),
        pct_complete: Math.max(0, Math.min(100, parseFloat(pct || '0'))),
        rev_rec_method_override: override === '' ? null : override,
      };
      const res = await fetch(`/api/jobs/${job.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await res.json();
      if (!res.ok) { addToast('error', result.error ?? 'Save failed'); return; }
      addToast('success', 'Recognition inputs saved');
      onSaved();
    } catch {
      addToast('error', 'Network error');
    } finally {
      setSaving(false);
    }
  }, [contract, estimate, pct, override, job.id, onSaved]);

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-white flex items-center gap-2"><Percent size={15} className="text-brand-400" /> Recognition Inputs</h2>
        <span className="text-2xs text-slate-500">
          {job.revenue_recognized_cents != null ? `Recognized to date: ${formatMoney(job.revenue_recognized_cents)}` : ''}
          {job.rev_rec_last_run_on ? ` · last run ${job.rev_rec_last_run_on}` : ''}
        </span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Field label="Contract value">
          <input value={contract} onChange={(e) => setContract(e.target.value)} inputMode="decimal"
            className="w-full px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-md text-sm text-white font-mono" />
        </Field>
        <Field label="Cost estimate">
          <input value={estimate} onChange={(e) => setEstimate(e.target.value)} inputMode="decimal"
            className="w-full px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-md text-sm text-white font-mono" />
        </Field>
        <Field label="% complete">
          <input value={pct} onChange={(e) => setPct(e.target.value)} inputMode="decimal"
            className="w-full px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-md text-sm text-white font-mono" />
        </Field>
        <Field label="Method override">
          <select value={override} onChange={(e) => setOverride(e.target.value)}
            className="w-full px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-md text-sm text-white">
            <option value="">(use mapping / default)</option>
            {REV_REC_METHOD_OPTS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </Field>
      </div>
      <div className="flex items-center justify-between mt-3">
        <p className="text-2xs text-slate-500">
          % complete is used only when the resolved method is physical-% POC; cost-to-cost derives its own % from cost ÷ estimate.
        </p>
        <button onClick={save} disabled={!dirty || saving}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40">
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Save
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-2xs uppercase tracking-wider text-slate-500 font-semibold">{label}</label>
      <div className="mt-1">{children}</div>
    </div>
  );
}
