'use client';

/**
 * Departments tab (Wave 4B, AC-B19 / AC-B17 / AC-B11): the submission board — every department with
 * owner, status, due date, plan vs last year, gap to target — with the owner's Submit and finance's
 * Return / Approve / Reopen, owner assignment and targets; Open drills into the department view.
 */
import { useState } from 'react';
import {
  Button,
  ConfirmDialog,
  Dialog,
  Field,
  Input,
  InlineNotice,
  Meter,
  MoneyInput,
  Select,
  Status,
  countStrokes,
  longDate,
  money,
  api,
  toast,
  useQuery,
} from '@meritbooks/merit-ui';
import { BOARD_STATUS_LABEL, type BoardResponse, type BoardRow } from '@/lib/budgets/types';
import { errText, pctText, planKind } from './budget-format';
import { ScopeBar, useBudgetScope } from './budget-scope';
import { DepartmentView } from './department-view';
import { VersionBar } from './version-bar';
import s from './budgets.module.css';

interface OwnersResponse {
  departments: Array<{ id: string; name: string }>;
  owners: Array<{ departmentId: string; ownerUserId: string; ownerName: string | null }>;
  candidates: Array<{ userId: string; name: string; email: string | null; role: string | null }>;
  canAssign: boolean;
}

type PlanAct = 'submit' | 'return' | 'approve' | 'reopen';

export function DepartmentsTab() {
  const sc = useBudgetScope();
  const [open, setOpen] = useState<{ id: string | null; name: string } | null>(null);
  if (open && sc.locationId) {
    return (
      <div>
        <div className={s.bar}>
          <Button variant="quiet" icon="left" onClick={() => setOpen(null)}>All departments</Button>
        </div>
        <DepartmentView locationId={sc.locationId} fiscalYear={sc.fiscalYear} departmentId={open.id} departmentName={open.name} versionId={sc.versionId} access={sc.access} />
      </div>
    );
  }
  return (
    <div>
      <ScopeBar />
      {!sc.locationId ? (
        <div className={`${s.surface} ${s.state}`}><strong>Choose a company</strong><p>Department budgets are per company and fiscal year.</p></div>
      ) : (
        <>
          <VersionBar />
          {sc.versionId ? <Board versionId={sc.versionId} onOpen={(id, name) => setOpen({ id, name })} /> : !sc.loading && (
            <div className={`${s.surface} ${s.state}`}><strong>No FY {sc.fiscalYear} budget yet</strong><p>Create a version on the Plan tab (or with “New version” above) to open the departments.</p></div>
          )}
        </>
      )}
    </div>
  );
}

function Board({ versionId, onOpen }: { versionId: string; onOpen: (departmentId: string | null, name: string) => void }) {
  const sc = useBudgetScope();
  const bq = useQuery<BoardResponse>('/api/budgets/board', { version_id: versionId });
  const oq = useQuery<OwnersResponse>(sc.locationId ? '/api/budgets/owners' : null, { location_id: sc.locationId });
  const [act, setAct] = useState<{ row: BoardRow; action: PlanAct } | null>(null);
  const [targets, setTargets] = useState<BoardRow | null>(null);
  const b = bq.data;
  const a = b?.access ?? sc.access;
  const finance = !!a && a.scope === 'ALL' && a.canEdit;
  const draft = b?.version.status === 'DRAFT';

  const runPlan = async (row: BoardRow, action: PlanAct, note?: string, gapNote?: string) => {
    const res = await api.post('/api/budgets/plans', { version_id: versionId, department_id: row.departmentId, action, note: note ?? null, gap_note: gapNote ?? null });
    if (res.error) return toast.error(errText(res.error));
    toast(`${row.departmentName}: ${action === 'submit' ? 'submitted' : action === 'return' ? 'returned' : action === 'approve' ? 'approved' : 'reopened'}`);
    await bq.refetch();
  };

  const setOwner = async (row: BoardRow, userId: string) => {
    const c = oq.data?.candidates.find((x) => x.userId === userId);
    const res = await api.put('/api/budgets/owners', { location_id: sc.locationId, department_id: row.departmentId, owner_user_id: userId || null, owner_name: c?.name ?? null, owner_email: c?.email ?? null });
    if (res.error) return toast.error(errText(res.error));
    toast(userId ? `${c?.name ?? 'Owner'} now owns ${row.departmentName}` : `${row.departmentName} has no owner`);
    await Promise.all([bq.refetch(), oq.refetch()]);
  };

  if (bq.isLoading && !b) return <div className={`${s.surface} ${s.state}`} aria-busy="true">Loading departments…</div>;
  if (bq.error) return <InlineNotice tone="neg" title="Couldn’t load the board" className={s.notice}>{bq.error}</InlineNotice>;
  if (!b) return null;
  const p = b.progress;

  return (
    <>
      <div className={s.strip}>
        <div className={s.cell}>
          <span className={s.cellL}>Departments approved</span>
          <span className={s.cellV}>{p.approved} of {p.total}</span>
          <Meter strokes={countStrokes(Math.max(1, p.total), p.approved, p.submitted)} label={`${p.approved} of ${p.total} approved, ${p.submitted} submitted`} />
        </div>
        <div className={s.cell}><span className={s.cellL}>Awaiting review</span><span className={s.cellV}>{p.submitted}</span></div>
        <div className={s.cell}><span className={s.cellL}>Overdue</span><span className={`${s.cellV} ${p.overdue ? s.neg : ''}`}>{p.overdue}</span></div>
        <div className={s.cell}>
          <span className={s.cellL}>Plan expense (departments)</span>
          <span className={s.cellV}>{money(b.rows.reduce((t, r) => t + r.expenseCents, 0))}</span>
          <span className={s.cellS}>Last year {money(b.rows.reduce((t, r) => t + r.pyExpenseCents, 0))}</span>
        </div>
      </div>
      {!draft && <InlineNotice tone="info" className={s.notice}>This version is {b.version.status === 'IN_REVIEW' ? 'in review' : b.version.status.toLowerCase()} — department budgets are frozen.</InlineNotice>}
      <div className={s.surface}>
        <div className={s.toolbar}><span className={s.toolbarTitle}>Submission board · {b.version.label}</span></div>
        {b.rows.length === 0 ? (
          <div className={s.state}><strong>No departments</strong><p>{a?.scope === 'DEPARTMENTS' ? 'None of this company’s departments are assigned to you.' : 'Add departments under Settings → Dimensions to budget by department.'}</p></div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>Department</th><th>Owner</th><th>Status</th><th>Due</th>
                  <th className={s.n}>Revenue</th><th className={s.n}>Expense</th><th className={s.n}>Last year exp.</th><th className={s.n}>Δ%</th><th className={s.n}>Gap to target</th><th className={s.n}>Open notes</th><th><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r) => {
                  const submittedByMe = r.plan?.submittedBy === a?.userId;
                  return (
                    <tr key={r.departmentId}>
                      <td><button type="button" className={s.linkBtn} onClick={() => onOpen(r.departmentId, r.departmentName)}>{r.departmentName}</button></td>
                      <td>
                        {oq.data?.canAssign && draft ? (
                          <Select aria-label={`Owner of ${r.departmentName}`} value={r.ownerUserId ?? ''} onChange={(e) => setOwner(r, e.target.value)}>
                            <option value="">No owner</option>
                            {r.ownerUserId && !oq.data.candidates.some((c) => c.userId === r.ownerUserId) && <option value={r.ownerUserId}>{r.ownerName ?? r.ownerUserId}</option>}
                            {oq.data.candidates.map((c) => <option key={c.userId} value={c.userId}>{c.name}</option>)}
                          </Select>
                        ) : (r.ownerName ?? <span className={s.muted}>Finance</span>)}
                      </td>
                      <td>{(() => {
                        const kind = planKind(r.status, r.overdue);
                        const label = r.overdue ? `${BOARD_STATUS_LABEL[r.status]} · overdue` : BOARD_STATUS_LABEL[r.status];
                        return kind ? <Status kind={kind}>{label}</Status> : <span className={s.muted}>{label}</span>;
                      })()}{r.plan?.reviewNote && r.status === 'RETURNED' && <div className={s.hint} title={r.plan.reviewNote}>“{r.plan.reviewNote}”</div>}</td>
                      <td className={r.overdue ? s.neg : undefined}>{r.dueDate ? longDate(r.dueDate) : '—'}</td>
                      <td className={s.n}>{money(r.revenueCents)}</td>
                      <td className={s.n}>{money(r.expenseCents)}</td>
                      <td className={`${s.n} ${s.muted}`}>{money(r.pyExpenseCents)}</td>
                      <td className={s.n}>{pctText(r.expenseChangePct)}</td>
                      <td className={`${s.n} ${r.expenseGapCents ? (r.expenseGapCents > 0 ? s.neg : s.pos) : ''}`}>{r.expenseGapCents === null ? '—' : money(r.expenseGapCents, { sign: 'delta' })}</td>
                      <td className={s.n}>{r.openComments || '—'}</td>
                      <td>
                        <div className={s.row}>
                          <Button variant="quiet" onClick={() => onOpen(r.departmentId, r.departmentName)}>Open</Button>
                          {draft && r.canEdit && ['NOT_STARTED', 'DRAFT', 'RETURNED'].includes(r.status) && <Button onClick={() => setAct({ row: r, action: 'submit' })}>Submit</Button>}
                          {draft && finance && r.status === 'SUBMITTED' && <Button onClick={() => setAct({ row: r, action: 'return' })}>Return</Button>}
                          {draft && a?.canApprove && a.scope === 'ALL' && r.status === 'SUBMITTED' && !submittedByMe && (
                            <Button variant="primary" onClick={() => setAct({ row: r, action: 'approve' })}>Approve</Button>
                          )}
                          {draft && finance && (r.status === 'APPROVED' || r.status === 'SUBMITTED') && <Button variant="quiet" onClick={() => setAct({ row: r, action: 'reopen' })}>Reopen</Button>}
                          {draft && finance && <Button variant="quiet" onClick={() => setTargets(r)}>Targets</Button>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {b.companyLevel && (
          <div className={s.saveBar}>
            <button type="button" className={s.linkBtn} onClick={() => onOpen(null, 'Company level')}>Company-level lines</button>
            <span className={s.hint}>Revenue {money(b.companyLevel.revenueCents)} · Expense {money(b.companyLevel.expenseCents)} (not owned by a department)</span>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!act && (act.action === 'submit' || act.action === 'reopen' || (act.action === 'approve' && !act.row.expenseGapCents))}
        onClose={() => setAct(null)}
        onConfirm={async () => { const x = act; setAct(null); if (x) await runPlan(x.row, x.action); }}
        title={act ? `${act.action === 'submit' ? 'Submit' : act.action === 'reopen' ? 'Reopen' : 'Approve'} ${act.row.departmentName}?` : ''}
        confirmLabel={act?.action === 'submit' ? 'Submit for review' : act?.action === 'reopen' ? 'Reopen to draft' : 'Approve department'}
      >
        {act?.action === 'submit' && <p>The department’s lines freeze until finance approves or returns it.</p>}
        {act?.action === 'approve' && <p>Approved departments are locked until reopened. The version can be approved once every department is.</p>}
      </ConfirmDialog>
      <ConfirmDialog
        open={!!act && (act.action === 'return' || (act.action === 'approve' && !!act.row.expenseGapCents))}
        onClose={() => setAct(null)}
        onConfirm={async (reason) => { const x = act; setAct(null); if (x) await (x.action === 'return' ? runPlan(x.row, 'return', reason) : runPlan(x.row, 'approve', undefined, reason)); }}
        title={act?.action === 'return' ? `Return ${act.row.departmentName}` : `Approve ${act?.row.departmentName ?? ''} off target`}
        confirmLabel={act?.action === 'return' ? 'Return to owner' : 'Approve with note'}
        reason={act?.action === 'return'
          ? { label: 'What needs to change', minLength: 3 }
          : { label: `The plan is ${act ? money(act.row.expenseGapCents ?? 0, { sign: 'delta' }) : ''} off its expense target — why is that accepted?`, minLength: 3 }}
      />
      {targets && <TargetsDialog row={targets} versionId={versionId} onClose={() => setTargets(null)} onSaved={() => bq.refetch()} />}
    </>
  );
}

function TargetsDialog({ row, versionId, onClose, onSaved }: { row: BoardRow; versionId: string; onClose: () => void; onSaved: () => void }) {
  const [rev, setRev] = useState<number | null>(row.plan?.targetRevenueCents ?? null);
  const [exp, setExp] = useState<number | null>(row.plan?.targetExpenseCents ?? null);
  const [due, setDue] = useState(row.plan?.dueDate ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    const res = await api.patch('/api/budgets/plans', { version_id: versionId, department_id: row.departmentId, target_revenue_cents: rev, target_expense_cents: exp, due_date: due || null });
    setBusy(false);
    if (res.error) return setError(errText(res.error));
    toast(`Targets saved for ${row.departmentName}`);
    onSaved();
    onClose();
  };
  return (
    <Dialog open onClose={onClose} title={`Targets · ${row.departmentName}`}
      actions={<><Button variant="quiet" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save targets'}</Button></>}
      footNote="Top-down targets: the owner plans bottom-up; a gap needs a note before approval.">
      {error && <InlineNotice tone="neg" className={s.notice}>{error}</InlineNotice>}
      <div className={s.formGrid}>
        <Field label="Revenue target (year)"><MoneyInput valueCents={rev} onChangeCents={setRev} /></Field>
        <Field label="Expense target (year)" help={`Plan today ${money(row.expenseCents)} · last year ${money(row.pyExpenseCents)}`}><MoneyInput valueCents={exp} onChangeCents={setExp} /></Field>
        <Field label="Due date"><Input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
      </div>
    </Dialog>
  );
}
