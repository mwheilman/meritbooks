'use client';

import { useMemo, useState } from 'react';
import { Button, Dialog, Field, InlineNotice, Input, Select, Tag, cx } from '@meritbooks/merit-ui';
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
import s from './payroll.module.css';

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

const STEP_LABELS = ['Roster & inputs', 'Preview'] as const;

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

  // Live field-level hints (the same rules validate() enforces on submit).
  const periodError = periodStart && periodEnd && periodEnd < periodStart ? 'The end must be on or after the start.' : undefined;
  const needsInput = (e: EmpDraft) => {
    const hasHours = e.payBasis === 'HOURLY' && Number(e.hours) > 0;
    const hasEarning = e.earnings.some((ln) => ln.type && Number(ln.amount.replace(/[,$\s]/g, '')) > 0);
    return !hasHours && !hasEarning;
  };

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

  const stepIndex = step === 'inputs' ? 0 : 1;

  return (
    <Dialog
      open
      onClose={() => { if (!busy) onClose(); }}
      dismissOnScrim={false}
      width={880}
      className={s.tallDialog}
      title={
        <span className={s.dialogTitle}>
          {providerReady ? 'Run payroll' : 'Estimate a payroll run'}
          {!providerReady && <Tag tone="warn">Estimate</Tag>}
        </span>
      }
      footNote={
        step === 'inputs' ? (
          <span className="tnum">
            {selected.length} employee{selected.length === 1 ? '' : 's'} on this run
          </span>
        ) : (
          <Button variant="quiet" icon="left" onClick={() => setStep('inputs')}>
            Back to inputs
          </Button>
        )
      }
      actions={
        step === 'inputs' ? (
          <>
            <Button onClick={onClose} disabled={busy}>Cancel</Button>
            <Button variant="primary" iconAfter="right" onClick={() => void createAndPreview()} disabled={busy} aria-busy={busy || undefined}>
              {busy ? 'Computing preview…' : 'Preview run'}
            </Button>
          </>
        ) : (
          <Button variant="primary" iconAfter="right" onClick={() => runId && onReview(runId)}>
            Review &amp; approve
          </Button>
        )
      }
    >
      <div className={s.body}>
        <div className={s.steps} aria-label="Run steps">
          {STEP_LABELS.map((label, i) => (
            <span
              key={label}
              className={cx(s.step, i === stepIndex && s.stepOn, i < stepIndex && s.stepDone)}
              aria-current={i === stepIndex ? 'step' : undefined}
            >
              <span className={s.stepNo} aria-hidden="true">{i + 1}</span>
              {i === 1 && !providerReady ? 'Estimated preview' : label}
            </span>
          ))}
        </div>

        {step === 'inputs' ? (
          <>
            {!providerReady && (
              <InlineNotice tone="warn" title="No payroll provider connected — this is an estimate.">
                The next step computes gross-to-net with flat placeholder rates (about 18% employee, 9% employer). It is
                not a tax calculation: nothing is withheld, filed or paid, and no money moves. Connect a payroll provider
                under Integrations to run real payroll. To book actual payroll now, close this and use Import register.
              </InlineNotice>
            )}

            {/* Header inputs */}
            <div className={s.grid3}>
              <Field label="Company">
                <Select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                  <option value="">All / default</option>
                  {me.locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.code ? `${l.code} · ${l.name}` : l.name}
                    </option>
                  ))}
                </Select>
              </Field>
              {paySchedules.length > 0 && (
                <Field label="Pay schedule">
                  <Select value={payScheduleId} onChange={(e) => setPayScheduleId(e.target.value)}>
                    <option value="">—</option>
                    {paySchedules.map((sc) => (
                      <option key={sc.id} value={sc.id}>
                        {sc.label}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              <Field label="Pay date">
                <Input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
              </Field>
              <Field label="Period start">
                <Input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
              </Field>
              <Field label="Period end" error={periodError}>
                <Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
              </Field>
              <Field label="Memo">
                <Input
                  type="text"
                  value={memo}
                  onChange={(e) => setMemo(e.target.value)}
                  placeholder="e.g. Biweekly — first half July"
                />
              </Field>
            </div>

            {/* Roster */}
            <section>
              <div className={s.sectionHead}>
                <span className="eyebrow">Employees on this run</span>
                <span className="t-cap tnum">{selected.length}</span>
              </div>

              {selected.length === 0 ? (
                <div className={s.dashed} style={{ marginTop: 8 }}>No one is on this run yet. Add people from the roster below.</div>
              ) : (
                <ul className={s.empList} style={{ marginTop: 8 }} aria-label="Employees on this run">
                  {selected.map((e) => {
                    const missing = needsInput(e);
                    return (
                      <li key={e.employeeId} className={s.emp}>
                        <div className={s.empHead}>
                          <span className={s.empName}>
                            <span className="b mb-trunc">{e.name}</span>
                            <Tag>{e.isContractor ? '1099 contractor' : e.payBasis === 'SALARY' ? 'Salary' : 'Hourly'}</Tag>
                            {missing && <span className="t-cap warn">Needs hours or an earning</span>}
                          </span>
                          <Button
                            variant="quiet"
                            icon="x"
                            iconOnly
                            onClick={() => removeEmp(e.employeeId)}
                            aria-label={`Remove ${e.name} from the run`}
                            title={`Remove ${e.name}`}
                          />
                        </div>

                        <div className={s.empInputs}>
                          {e.payBasis === 'HOURLY' ? (
                            <Field label="Hours">
                              <Input
                                type="number"
                                min="0"
                                step="0.25"
                                value={e.hours}
                                onChange={(ev) => updateEmp(e.employeeId, { hours: ev.target.value })}
                                className="input--money"
                              />
                            </Field>
                          ) : (
                            <span />
                          )}

                          {/* Earning lines */}
                          <div className={s.earnings}>
                            {e.earnings.map((ln, i) => (
                              <div key={i} className={s.earning}>
                                <Select
                                  value={ln.type}
                                  onChange={(ev) => updateEarning(e.employeeId, i, { type: ev.target.value })}
                                  aria-label={`Earning type ${i + 1} for ${e.name}`}
                                >
                                  {EARNING_TYPES.map((t) => (
                                    <option key={t.value} value={t.value}>
                                      {t.label}
                                    </option>
                                  ))}
                                </Select>
                                <Input
                                  type="text"
                                  inputMode="decimal"
                                  value={ln.amount}
                                  onChange={(ev) => updateEarning(e.employeeId, i, { amount: ev.target.value })}
                                  placeholder="$0.00"
                                  className="input--money"
                                  aria-label={`Earning amount ${i + 1} for ${e.name}, in dollars`}
                                />
                                <Button
                                  variant="quiet"
                                  icon="x"
                                  iconOnly
                                  onClick={() => removeEarning(e.employeeId, i)}
                                  aria-label={`Remove earning ${i + 1} for ${e.name}`}
                                />
                              </div>
                            ))}
                            <Button variant="quiet" icon="plus" onClick={() => addEarning(e.employeeId)}>
                              Add an earning
                            </Button>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}

              {/* Add-from-roster */}
              <div className={s.roster} style={{ marginTop: 16 }}>
                <span className="eyebrow">Roster</span>
                {rosterLoading ? (
                  <div className={s.rosterChips} aria-busy="true">
                    <span className="mb-skel" style={{ width: 120, height: 32 }} aria-hidden="true" />
                    <span className="mb-skel" style={{ width: 96, height: 32 }} aria-hidden="true" />
                    <span className="mb-skel" style={{ width: 136, height: 32 }} aria-hidden="true" />
                    <span className="sr" role="status">Loading employees…</span>
                  </div>
                ) : rosterError ? (
                  <div style={{ marginTop: 8 }}>
                    <InlineNotice tone="neg" title="The employee roster didn’t load.">
                      {rosterError}. Set up employees and their pay before running payroll.
                    </InlineNotice>
                  </div>
                ) : availableToAdd.length === 0 ? (
                  <p className="t-cap" style={{ marginTop: 8 }}>
                    {roster.length === 0
                      ? 'No employees yet. Add employees and their pay to run payroll.'
                      : 'Everyone on the roster is already on this run.'}
                  </p>
                ) : (
                  <div className={s.rosterChips}>
                    {availableToAdd.map((e) => (
                      <Button key={e.id} icon="plus" onClick={() => addEmployee(e)}>
                        {e.name}
                        {e.departmentName && <span className={s.muted}>· {e.departmentName}</span>}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            </section>
          </>
        ) : (
          <PreviewStep detail={detail} providerReady={providerReady} grouped={me.user?.payrollVisibility !== 'ungrouped'} />
        )}
      </div>
    </Dialog>
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
      <div className={s.phase} aria-busy="true">
        <div className={s.phaseBars} aria-hidden="true">
          <span className="mb-skel" style={{ width: '72%' }} />
          <span className="mb-skel" style={{ width: '56%' }} />
        </div>
        <span className="sr" role="status">Loading the preview…</span>
      </div>
    );
  }
  const { run, employees } = detail;
  const funding = run.fundingCents ?? run.netCents + (run.employeeTaxCents ?? 0) + (run.employerTaxCents ?? 0);
  const est = providerReady ? '' : ' (est.)';
  const totals = employees.reduce(
    (t, e) => ({
      gross: t.gross + e.grossCents,
      tax: t.tax + e.employeeTaxCents,
      ded: t.ded + e.deductionsCents,
      net: t.net + e.netCents,
    }),
    { gross: 0, tax: 0, ded: 0, net: 0 },
  );
  const fig = (label: string, cents: number) => (
    <div className="fig">
      <span className="fig-l">{label}</span>
      <span className="fig-v fig-v--dense tnum">{formatMoney(cents)}</span>
    </div>
  );
  return (
    <>
      {providerReady ? (
        <InlineNotice tone="info" title="Computed by the payroll provider.">
          This gross-to-net comes from the provider, not the ledger. Review the totals before sending the run for
          approval. Nothing has moved: no money leaves the bank until a second person approves and then releases the run.
        </InlineNotice>
      ) : (
        <InlineNotice tone="warn" title="Estimated figures — not a tax calculation.">
          With no provider connected these totals use flat placeholder rates (about 18% employee, 9% employer), so
          withholding and net pay are approximate. Nothing is withheld, filed or paid, and no money moves. Use this to
          preview the workflow only.
        </InlineNotice>
      )}

      {/* Totals */}
      <div className={s.figs}>
        {fig('Gross', run.grossCents)}
        {fig(`Employee tax${est}`, run.employeeTaxCents ?? 0)}
        {fig(`Employer tax${est}`, run.employerTaxCents ?? 0)}
        {fig(`Net pay${est}`, run.netCents)}
      </div>

      <div className={s.funding}>
        <span className="ink-2">Funding total that will debit the bank (net + taxes + garnishments)</span>
        <span className={s.fundingFig}>{formatMoney(funding)}</span>
      </div>

      {/* Per-employee */}
      {grouped ? (
        <p className="t-cap">Individual pay amounts are hidden for your role (grouped payroll visibility). Totals are above.</p>
      ) : employees.length === 0 ? (
        <p className="t-cap">The provider returned no employee lines for this run. The totals above are the run’s.</p>
      ) : (
        <div className={s.lines}>
          <table className="tbl tbl-q tbl-q--compact" aria-label="Pay by employee">
            <colgroup>
              <col />
              <col style={{ width: 128 }} />
              <col style={{ width: 128 }} />
              <col style={{ width: 128 }} />
              <col style={{ width: 128 }} />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Employee</th>
                <th scope="col" className="n">Gross</th>
                <th scope="col" className="n">Employee tax</th>
                <th scope="col" className="n">Deductions</th>
                <th scope="col" className="n">Net</th>
              </tr>
            </thead>
            <tbody>
              {employees.map((e) => (
                <tr key={e.employeeId} className="q-row">
                  <td><span className="l1">{e.name}</span></td>
                  <td className="n">{formatMoney(e.grossCents)}</td>
                  <td className="n">{formatMoney(e.employeeTaxCents)}</td>
                  <td className="n">{formatMoney(e.deductionsCents)}</td>
                  <td className="n">{formatMoney(e.netCents)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Total · <span className="tnum">{employees.length}</span></td>
                <td className="n">{formatMoney(totals.gross)}</td>
                <td className="n">{formatMoney(totals.tax)}</td>
                <td className="n">{formatMoney(totals.ded)}</td>
                <td className="n">{formatMoney(totals.net)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </>
  );
}
