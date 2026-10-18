'use client';

import { useMemo, useState } from 'react';
import { clsx } from 'clsx';
import {
  X,
  Loader2,
  Plus,
  Trash2,
  Users,
  Sparkles,
  ChevronRight,
  ArrowLeft,
  AlertCircle,
  FlaskConical,
} from 'lucide-react';
import { useQuery, addToast } from '@/hooks';
import { useMe } from '@/lib/hooks/use-me';
import { formatMoney, dollarsToCents } from '@meritbooks/shared';
import type {
  EmployeeOption,
  PayScheduleOption,
  RunDetail,
  RunDetailResponse,
  RunEmployeeLine,
} from './types';
import { EARNING_TYPES } from './types';

interface EarningDraft {
  type: string;
  amount: string; // dollars, as typed
}

interface EmpDraft {
  employeeId: string;
  name: string;
  payBasis: 'HOURLY' | 'SALARY';
  hours: string;
  earnings: EarningDraft[];
  isContractor?: boolean;
}

type Step = 'inputs' | 'preview';

export function RunWizard({
  providerReady,
  onClose,
  onCreated,
  onReview,
}: {
  /** True only when a licensed payroll provider is connected for this tenant.
   *  When false, the wizard is a non-binding ESTIMATE (flat placeholder rates). */
  providerReady: boolean;
  onClose: () => void;
  onCreated: () => void;
  onReview: (runId: string) => void;
}) {
  const me = useMe();
  const [step, setStep] = useState<Step>('inputs');

  // Run header inputs
  const [locationId, setLocationId] = useState('');
  const [payScheduleId, setPayScheduleId] = useState('');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [payDate, setPayDate] = useState('');
  const [memo, setMemo] = useState('');

  // Roster
  const [selected, setSelected] = useState<EmpDraft[]>([]);
  const [busy, setBusy] = useState(false);

  // Preview result
  const [runId, setRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ run: RunDetail; employees: RunEmployeeLine[] } | null>(null);

  const { data: rosterResp, isLoading: rosterLoading, error: rosterError } = useQuery<{
    employees: EmployeeOption[];
  }>('/api/payroll/employees');
  const roster = rosterResp?.employees ?? [];

  // Optional pay schedules — silently omitted if the endpoint isn't present.
  const { data: schedResp } = useQuery<{ paySchedules: PayScheduleOption[] }>('/api/payroll/pay-schedules');
  const paySchedules = schedResp?.paySchedules ?? [];

  const availableToAdd = useMemo(
    () => roster.filter((e) => !selected.some((s) => s.employeeId === e.id)),
    [roster, selected],
  );

  function addEmployee(e: EmployeeOption) {
    const basis = e.payBasis ?? (e.annualSalaryCents ? 'SALARY' : 'HOURLY');
    setSelected((prev) => [
      ...prev,
      {
        employeeId: e.id,
        name: e.name,
        payBasis: basis,
        hours: basis === 'HOURLY' ? (e.standardHours ? String(e.standardHours) : '') : '',
        earnings:
          basis === 'SALARY'
            ? [{ type: 'SALARY', amount: e.annualSalaryCents ? (e.annualSalaryCents / 100 / 24).toFixed(2) : '' }]
            : [],
        isContractor: e.isContractor,
      },
    ]);
  }

  function updateEmp(id: string, patch: Partial<EmpDraft>) {
    setSelected((prev) => prev.map((e) => (e.employeeId === id ? { ...e, ...patch } : e)));
  }
  function removeEmp(id: string) {
    setSelected((prev) => prev.filter((e) => e.employeeId !== id));
  }
  function addEarning(id: string) {
    setSelected((prev) =>
      prev.map((e) => (e.employeeId === id ? { ...e, earnings: [...e.earnings, { type: 'BONUS', amount: '' }] } : e)),
    );
  }
  function updateEarning(id: string, i: number, patch: Partial<EarningDraft>) {
    setSelected((prev) =>
      prev.map((e) =>
        e.employeeId === id
          ? { ...e, earnings: e.earnings.map((ln, j) => (j === i ? { ...ln, ...patch } : ln)) }
          : e,
      ),
    );
  }
  function removeEarning(id: string, i: number) {
    setSelected((prev) =>
      prev.map((e) => (e.employeeId === id ? { ...e, earnings: e.earnings.filter((_, j) => j !== i) } : e)),
    );
  }

  function validate(): string | null {
    if (!periodStart || !periodEnd) return 'Enter the pay period start and end dates.';
    if (periodEnd < periodStart) return 'The pay period end must be on or after the start.';
    if (!payDate) return 'Enter a pay date.';
    if (selected.length === 0) return 'Add at least one employee to the run.';
    for (const e of selected) {
      const hasHours = e.payBasis === 'HOURLY' && Number(e.hours) > 0;
      const hasEarning = e.earnings.some((ln) => ln.type && Number(ln.amount.replace(/[,$\s]/g, '')) > 0);
      if (!hasHours && !hasEarning) {
        return `${e.name} needs hours or at least one earning amount.`;
      }
    }
    return null;
  }

  async function createAndPreview() {
    const err = validate();
    if (err) {
      addToast('error', err);
      return;
    }
    setBusy(true);
    try {
      const employeeInputs = selected.map((e) => ({
        employeeId: e.employeeId,
        hours: e.payBasis === 'HOURLY' && Number(e.hours) > 0 ? Number(e.hours) : undefined,
        earnings: e.earnings
          .filter((ln) => ln.type && Number(ln.amount.replace(/[,$\s]/g, '')) > 0)
          .map((ln) => ({ type: ln.type, amountCents: dollarsToCents(ln.amount) })),
      }));

      // 1. Create the DRAFT run.
      const createRes = await fetch('/api/payroll/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          locationId: locationId || undefined,
          payScheduleId: payScheduleId || undefined,
          periodStart,
          periodEnd,
          payDate,
          memo,
          employeeInputs,
        }),
      });
      const created = (await createRes.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!createRes.ok || !created.id) {
        addToast('error', created.error ?? 'Could not create the payroll run.');
        return;
      }
      onCreated();
      setRunId(created.id);

      // 2. Ask the provider engine to compute gross-to-net.
      const prevRes = await fetch(`/api/payroll/runs/${created.id}/preview`, { method: 'POST' });
      const prev = (await prevRes.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!prevRes.ok) {
        addToast('error', prev.error ?? 'Preview failed. The run was saved as a draft.');
        // Still advance so the user can review the draft from the list.
        onReview(created.id);
        return;
      }

      // 3. Read back the computed run.
      const detRes = await fetch(`/api/payroll/runs/${created.id}`);
      const det = (await detRes.json().catch(() => null)) as RunDetailResponse | null;
      if (det?.run) {
        setDetail({ run: det.run, employees: det.employees ?? [] });
        setStep('preview');
      } else {
        onReview(created.id);
      }
    } catch {
      addToast('error', 'Network error while creating the run.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 py-10">
      <div className="w-full max-w-3xl rounded-xl border border-slate-800 bg-surface-900 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
              Run payroll
              {!providerReady && (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-2xs font-medium text-amber-300">
                  <FlaskConical size={10} /> Estimate
                </span>
              )}
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              {step === 'inputs'
                ? 'Step 1 · Roster & inputs'
                : providerReady
                ? 'Step 2 · Provider-computed preview'
                : 'Step 2 · Estimated preview (no provider connected)'}
            </p>
          </div>
          <button onClick={onClose} className="rounded-md p-1.5 text-slate-500 hover:bg-white/[0.04] hover:text-slate-200" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {step === 'inputs' ? (
          <div className="max-h-[70vh] space-y-5 overflow-y-auto px-6 py-5">
            {!providerReady && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.08] p-3">
                <FlaskConical size={15} className="mt-0.5 shrink-0 text-amber-400" />
                <p className="text-xs text-amber-100/90">
                  <span className="font-semibold text-amber-200">No payroll provider connected — this is an estimate.</span>{' '}
                  The next step computes gross-to-net with flat placeholder rates (~18% employee, ~9% employer). It is{' '}
                  <span className="font-medium">not a tax calculation</span>, nothing is withheld, filed, or paid, and no
                  money moves. Connect a provider (Check / Gusto) under Integrations to run real payroll. To book actual
                  payroll now, close this and use <span className="text-slate-200">Import payroll register</span> instead.
                </p>
              </div>
            )}
            {/* Header inputs */}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              <Field label="Company / entity">
                <select
                  value={locationId}
                  onChange={(e) => setLocationId(e.target.value)}
                  className="input"
                >
                  <option value="">All / default</option>
                  {me.locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.code ? `${l.code} · ${l.name}` : l.name}
                    </option>
                  ))}
                </select>
              </Field>
              {paySchedules.length > 0 && (
                <Field label="Pay schedule">
                  <select value={payScheduleId} onChange={(e) => setPayScheduleId(e.target.value)} className="input">
                    <option value="">—</option>
                    {paySchedules.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <Field label="Pay date">
                <input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} className="input" />
              </Field>
              <Field label="Period start">
                <input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} className="input" />
              </Field>
              <Field label="Period end">
                <input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} className="input" />
              </Field>
              <Field label="Memo">
                <input
                  type="text"
                  value={memo}
                  onChange={(e) => setMemo(e.target.value)}
                  placeholder="e.g. Biweekly — first half July"
                  className="input"
                />
              </Field>
            </div>

            {/* Roster */}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-2xs font-semibold uppercase tracking-wider text-slate-500">
                  Employees on this run ({selected.length})
                </h3>
              </div>

              {selected.length === 0 && (
                <div className="rounded-lg border border-dashed border-slate-800 px-4 py-6 text-center text-xs text-slate-500">
                  No employees added yet. Add people from the roster below.
                </div>
              )}

              <div className="space-y-2">
                {selected.map((e) => (
                  <div key={e.employeeId} className="rounded-lg bg-slate-800/30 p-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-slate-200">{e.name}</span>
                        <span className="rounded bg-slate-700/50 px-1.5 py-0.5 text-2xs text-slate-400">
                          {e.isContractor ? '1099 contractor' : e.payBasis === 'SALARY' ? 'Salary' : 'Hourly'}
                        </span>
                      </div>
                      <button onClick={() => removeEmp(e.employeeId)} className="p-1 text-slate-500 hover:text-red-400">
                        <Trash2 size={14} />
                      </button>
                    </div>

                    <div className="mt-2 grid grid-cols-12 items-end gap-2">
                      {e.payBasis === 'HOURLY' && (
                        <label className="col-span-4 block md:col-span-3">
                          <span className="text-2xs uppercase tracking-wider text-slate-500">Hours</span>
                          <input
                            type="number"
                            min="0"
                            step="0.25"
                            value={e.hours}
                            onChange={(ev) => updateEmp(e.employeeId, { hours: ev.target.value })}
                            className="input mt-1 text-right font-mono"
                          />
                        </label>
                      )}
                    </div>

                    {/* Earning lines */}
                    <div className="mt-2 space-y-1.5">
                      {e.earnings.map((ln, i) => (
                        <div key={i} className="grid grid-cols-12 items-center gap-2">
                          <select
                            value={ln.type}
                            onChange={(ev) => updateEarning(e.employeeId, i, { type: ev.target.value })}
                            className="input col-span-6 text-xs md:col-span-4"
                          >
                            {EARNING_TYPES.map((t) => (
                              <option key={t.value} value={t.value}>
                                {t.label}
                              </option>
                            ))}
                          </select>
                          <input
                            type="text"
                            inputMode="decimal"
                            value={ln.amount}
                            onChange={(ev) => updateEarning(e.employeeId, i, { amount: ev.target.value })}
                            placeholder="0.00"
                            className="input col-span-5 text-right font-mono text-xs md:col-span-3"
                          />
                          <button
                            onClick={() => removeEarning(e.employeeId, i)}
                            className="col-span-1 p-1 text-slate-500 hover:text-red-400"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      ))}
                      <button
                        onClick={() => addEarning(e.employeeId)}
                        className="inline-flex items-center gap-1 text-2xs text-emerald-400 hover:text-emerald-300"
                      >
                        <Plus size={11} /> Add earning (bonus, commission, reimbursement…)
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              {/* Add-from-roster */}
              <div className="mt-3 rounded-lg border border-slate-800 p-3">
                <div className="mb-2 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-slate-500">
                  <Users size={12} /> Roster
                </div>
                {rosterLoading ? (
                  <div className="flex items-center gap-2 py-2 text-xs text-slate-500">
                    <Loader2 size={13} className="animate-spin" /> Loading employees…
                  </div>
                ) : rosterError ? (
                  <div className="flex items-start gap-2 py-2 text-xs text-amber-400">
                    <AlertCircle size={13} className="mt-0.5 shrink-0" />
                    <span>
                      Could not load the employee roster ({rosterError}). Set up employees and comp before running
                      payroll.
                    </span>
                  </div>
                ) : availableToAdd.length === 0 ? (
                  <p className="py-2 text-xs text-slate-500">
                    {roster.length === 0
                      ? 'No employees found. Add employees and their comp to run payroll.'
                      : 'Everyone on the roster is already on this run.'}
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {availableToAdd.map((e) => (
                      <button
                        key={e.id}
                        onClick={() => addEmployee(e)}
                        className="inline-flex items-center gap-1 rounded-md bg-slate-800 px-2.5 py-1 text-xs text-slate-200 hover:bg-slate-700"
                      >
                        <Plus size={12} /> {e.name}
                        {e.departmentName && <span className="text-slate-500">· {e.departmentName}</span>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <PreviewStep detail={detail} providerReady={providerReady} grouped={me.user?.payrollVisibility !== 'ungrouped'} />
        )}

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 border-t border-slate-800 px-6 py-4">
          {step === 'inputs' ? (
            <>
              <button onClick={onClose} className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200">
                Cancel
              </button>
              <button
                onClick={createAndPreview}
                disabled={busy}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <ChevronRight size={14} />}
                {busy ? 'Computing preview…' : 'Preview run'}
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setStep('inputs')}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm text-slate-400 hover:text-slate-200"
              >
                <ArrowLeft size={14} /> Back to inputs
              </button>
              <button
                onClick={() => runId && onReview(runId)}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
              >
                Review &amp; approve <ChevronRight size={14} />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function PreviewStep({
  detail,
  providerReady,
  grouped,
}: {
  detail: { run: RunDetail; employees: RunEmployeeLine[] } | null;
  providerReady: boolean;
  grouped: boolean;
}) {
  if (!detail) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-5 w-5 animate-spin text-emerald-400" />
      </div>
    );
  }
  const { run, employees } = detail;
  const funding = run.fundingCents ?? run.netCents + (run.employeeTaxCents ?? 0) + (run.employerTaxCents ?? 0);
  return (
    <div className="max-h-[70vh] space-y-4 overflow-y-auto px-6 py-5">
      {providerReady ? (
        <div className="flex items-start gap-2 rounded-lg border border-indigo-500/20 bg-indigo-500/[0.06] p-3">
          <Sparkles size={15} className="mt-0.5 shrink-0 text-indigo-400" />
          <p className="text-xs text-slate-300">
            This gross-to-net is <span className="font-medium text-indigo-300">computed by the payroll provider</span>,
            not by the accounting system. Review the totals before sending the run for approval. Nothing has moved — no
            money leaves the bank until a second person approves and then explicitly releases the run.
          </p>
        </div>
      ) : (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.08] p-3">
          <FlaskConical size={15} className="mt-0.5 shrink-0 text-amber-400" />
          <p className="text-xs text-amber-100/90">
            <span className="font-semibold text-amber-200">Estimated figures — not a tax calculation.</span> With no
            provider connected these totals use flat placeholder rates (~18% employee, ~9% employer), so the
            withholding and net pay are approximate. Nothing is withheld, filed, or paid, and no money moves. Use this
            to preview the workflow only.
          </p>
        </div>
      )}

      {/* Totals */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <MiniStat label="Gross" value={formatMoney(run.grossCents)} />
        <MiniStat label={providerReady ? 'Employee tax' : 'Employee tax (est.)'} value={formatMoney(run.employeeTaxCents ?? 0)} />
        <MiniStat label={providerReady ? 'Employer tax' : 'Employer tax (est.)'} value={formatMoney(run.employerTaxCents ?? 0)} />
        <MiniStat label={providerReady ? 'Net pay' : 'Net pay (est.)'} value={formatMoney(run.netCents)} tone="ok" />
      </div>

      <div className="flex items-center justify-between rounded-lg bg-slate-800/50 px-4 py-3">
        <span className="text-xs text-slate-400">Funding total (net + taxes + garnishments) that will debit the bank</span>
        <span className="font-mono text-base font-semibold tabular-nums text-white">{formatMoney(funding)}</span>
      </div>

      {/* Per-employee */}
      {grouped ? (
        <p className="text-xs text-slate-500">
          Individual pay amounts are hidden for your role (grouped payroll visibility). Totals shown above.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-800">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-800">
                <Th>Employee</Th>
                <Th align="right">Gross</Th>
                <Th align="right">EE tax</Th>
                <Th align="right">Deductions</Th>
                <Th align="right">Net</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/30">
              {employees.map((e) => (
                <tr key={e.employeeId} className="hover:bg-slate-800/20">
                  <td className="px-3 py-2 text-sm text-slate-200">{e.name}</td>
                  <td className="px-3 py-2 text-right font-mono text-sm tabular-nums text-slate-300">{formatMoney(e.grossCents)}</td>
                  <td className="px-3 py-2 text-right font-mono text-sm tabular-nums text-slate-400">{formatMoney(e.employeeTaxCents)}</td>
                  <td className="px-3 py-2 text-right font-mono text-sm tabular-nums text-slate-400">{formatMoney(e.deductionsCents)}</td>
                  <td className="px-3 py-2 text-right font-mono text-sm tabular-nums text-emerald-400">{formatMoney(e.netCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-2xs font-semibold uppercase tracking-wider text-slate-500">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: string; tone?: 'ok' }) {
  return (
    <div className="rounded-lg bg-slate-800/30 p-3">
      <p className="text-2xs uppercase tracking-wider text-slate-500">{label}</p>
      <p className={clsx('mt-1 font-mono text-sm font-semibold tabular-nums', tone === 'ok' ? 'text-emerald-400' : 'text-slate-200')}>
        {value}
      </p>
    </div>
  );
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      className={clsx(
        'px-3 py-2 text-2xs font-semibold uppercase tracking-wider text-slate-500',
        align === 'right' ? 'text-right' : 'text-left',
      )}
    >
      {children}
    </th>
  );
}
