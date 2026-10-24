'use client';

/**
 * The task side panel (double-click a bar or row): dates and float, progress and actual dates,
 * crew, constraint, predecessors, successors and baseline variance. Supervisors in field mode
 * get the big buttons: Started today, Finished today, % steps and Push a day / a week.
 * Billing amounts show only with projects.contract_value (masked server-side as well).
 */
import { useEffect, useMemo, useState } from 'react';
import { Button, ConfirmDialog, Field, Input, KV, Panel, PanelSection, Seg, Select, Status, money, shortDate } from '@meritbooks/merit-ui';
import { addWorkdays, workdaysBetween } from '@/lib/pm/schedule/calendar';
import { DEP_WORDS, formatLinks } from '@/lib/pm/schedule/links';
import type { OutlineRow } from '@/lib/pm/schedule/tree';
import { CONSTRAINT_LABEL, CONSTRAINT_TYPES, type BaselineTask, type ConstraintType, type CrewOption, type SchedDep, type SchedTask, type TaskStatus, type WorkCalendar } from '@/lib/pm/schedule/types';
import { taskStatus } from '@/lib/pm/stage';
import { parseDayInput, parsePctInput } from '@/lib/pm/schedule/dates';
import type { ScheduleOp } from './useSchedule';

type Patch = Extract<ScheduleOp, { op: 'update' }>['patch'];

export interface TaskPanelProps {
  row: OutlineRow;
  rows: ReadonlyArray<OutlineRow>;
  deps: ReadonlyArray<SchedDep>;
  crews: ReadonlyArray<CrewOption>;
  cal: WorkCalendar;
  today: string;
  baseline: BaselineTask | null;
  canEdit: boolean;
  field: boolean;
  showBilling: boolean;
  busy: boolean;
  onClose: () => void;
  onSelect: (id: string) => void;
  onUpdate: (patch: Patch, verb: string) => Promise<boolean>;
  onLinks: (text: string) => Promise<string | null>;
  onPush: (days: number) => void;
  onDelete: () => Promise<void>;
}

const PCT_STEPS = [0, 25, 50, 75, 100] as const;
type PctStep = `${(typeof PCT_STEPS)[number]}`;

const days = (n: number) => `${n} ${Math.abs(n) === 1 ? 'day' : 'days'}`;

export function TaskPanel(p: TaskPanelProps) {
  const { row, rows, deps, crews, cal, today, baseline, canEdit, field, showBilling, busy } = p;
  const t: SchedTask = row.task;
  const leaf = !row.hasChildren;
  const byId = useMemo(() => new Map(rows.map((r) => [r.task.id, r])), [rows]);
  const preds = deps.filter((d) => d.succ_id === t.id);
  const succs = deps.filter((d) => d.pred_id === t.id);
  const predText = formatLinks(preds, (id) => (byId.has(id) ? String(byId.get(id)!.rowNo) : null), (id) => byId.get(id)?.rowNo ?? 0);

  const [title, setTitle] = useState(t.title);
  const [links, setLinks] = useState(predText);
  const [linkErr, setLinkErr] = useState<string | null>(null);
  const [pct, setPct] = useState(t.pct_complete != null ? String(Math.round(t.pct_complete * 100)) : '');
  const [aStart, setAStart] = useState(t.actual_start ?? '');
  const [aFinish, setAFinish] = useState(t.actual_finish ?? '');
  const [ctype, setCtype] = useState<ConstraintType>(t.constraint_type);
  const [cdate, setCdate] = useState(t.constraint_date ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);

  useEffect(() => {
    setTitle(t.title);
    setLinks(predText);
    setLinkErr(null);
    setPct(t.pct_complete != null ? String(Math.round(t.pct_complete * 100)) : '');
    setAStart(t.actual_start ?? '');
    setAFinish(t.actual_finish ?? '');
    setCtype(t.constraint_type);
    setCdate(t.constraint_date ?? '');
    setErr(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.id, t.title, t.pct_complete, t.actual_start, t.actual_finish, t.constraint_type, t.constraint_date, predText]);

  const st = taskStatus(t.status, !!t.due_on && t.due_on < today && t.status !== 'DONE' && t.status !== 'CANCELLED');
  const variance = baseline?.due_on && t.due_on ? workdaysBetween(cal, baseline.due_on, t.due_on) : null;
  const ro = !canEdit;

  const save = async () => {
    const patch: Patch = {};
    if (title.trim() && title.trim() !== t.title) patch.title = title.trim();
    if (leaf) {
      if (pct.trim() !== (t.pct_complete != null ? String(Math.round(t.pct_complete * 100)) : '')) {
        const v = parsePctInput(pct);
        if (v == null) return setErr('Type the percent complete as a number from 0 to 100.');
        patch.pct_complete = v;
      }
      const as = aStart ? parseDayInput(aStart, today) : null;
      const af = aFinish ? parseDayInput(aFinish, today) : null;
      if (aStart && !as) return setErr('Type the actual start as a date, like 11/18.');
      if (aFinish && !af) return setErr('Type the actual finish as a date, like 11/18.');
      if (as && af && af < as) return setErr('The actual finish is before the actual start.');
      if (af && af > today) return setErr('The actual finish is in the future. Use the planned finish for work not done yet.');
      if ((as ?? null) !== t.actual_start) patch.actual_start = as;
      if ((af ?? null) !== t.actual_finish) patch.actual_finish = af;
      if (ctype !== t.constraint_type || (cdate || null) !== t.constraint_date) {
        const cd = cdate ? parseDayInput(cdate, today) : null;
        if (ctype !== 'ASAP' && !cd) return setErr(`${CONSTRAINT_LABEL[ctype]} needs a date.`);
        patch.constraint_type = ctype;
        patch.constraint_date = ctype === 'ASAP' ? null : cd;
      }
    }
    setErr(null);
    if (leaf && links.trim() !== predText) {
      const e = await p.onLinks(links);
      setLinkErr(e);
      if (e) return;
    }
    if (Object.keys(patch).length) await p.onUpdate(patch, `Updated ${patch.title ?? t.title}`);
  };

  const quick = (patch: Patch, verb: string) => void p.onUpdate(patch, verb);
  const pctStep = PCT_STEPS.find((s) => t.pct_complete != null && Math.round(t.pct_complete * 100) === s);

  return (
    <Panel
      aria-label={`Task ${t.title}`}
      eyebrow={[`Row ${row.rowNo}`, `WBS ${row.wbs}`]}
      title={t.title}
      meta={<Status kind={st.kind} pip={st.pip}>{t.is_critical ? `${st.word} · critical` : st.word}</Status>}
      onClose={p.onClose}
      foot={
        canEdit ? (
          <div className="row" style={{ gap: 8 }}>
            <Button variant="primary" onClick={() => void save()} disabled={busy}>
              Save task
            </Button>
            <Button variant="quiet" onClick={p.onClose}>
              Close
            </Button>
            <span style={{ flex: 1 }} />
            <Button variant="danger" onClick={() => setConfirmDel(true)} disabled={busy || row.hasChildren} title={row.hasChildren ? 'Remove or outdent its tasks first' : undefined}>
              Remove task
            </Button>
          </div>
        ) : undefined
      }
    >
      <PanelSection title="Dates">
        <KV
          items={[
            { term: 'Start', value: t.start_on ? shortDate(t.start_on, today) : '—' },
            { term: 'Finish', value: t.due_on ? shortDate(t.due_on, today) : '—' },
            { term: 'Duration', value: t.is_milestone ? 'Milestone' : t.duration_days != null ? `${days(t.duration_days)} (working)` : '—' },
            { term: 'Total float', value: t.total_float == null ? 'Not calculated yet' : `${days(t.total_float)}${t.total_float < 0 ? ' — late against a constraint' : ''}` },
            { term: 'Free float', value: t.free_float == null ? '—' : days(t.free_float) },
            { term: 'Early / late start', value: `${t.early_start ? shortDate(t.early_start) : '—'} / ${t.late_start ? shortDate(t.late_start) : '—'}` },
            ...(baseline ? [{ term: 'Baseline finish', value: baseline.due_on ? `${shortDate(baseline.due_on, today)}${variance != null ? ` · ${variance === 0 ? 'on baseline' : variance > 0 ? `${days(variance)} late` : `${days(-variance)} early`}` : ''}` : '—' }] : []),
            ...(t.constraint_conflict ? [{ term: 'Constraint', value: 'Its predecessors push it past its constraint date' }] : []),
            ...(showBilling && t.billing_amount_cents != null ? [{ term: 'Billing amount', value: money(t.billing_amount_cents) }] : []),
          ]}
        />
      </PanelSection>

      {canEdit && leaf && field && (
        <PanelSection title="Update from the field">
          <div className="stack" style={{ gap: 8 }}>
            <Seg<PctStep>
              aria-label="Percent complete"
              items={PCT_STEPS.map((s) => ({ value: `${s}` as PctStep, label: `${s}%` }))}
              value={(pctStep != null ? `${pctStep}` : '0') as PctStep}
              onChange={(v) => quick(Number(v) === 100 ? { pct_complete: 1, status: 'DONE', actual_finish: t.actual_finish ?? today, actual_start: t.actual_start ?? today } : { pct_complete: Number(v) / 100, ...(Number(v) > 0 && !t.actual_start ? { actual_start: today } : {}) }, `Set ${t.title} to ${v}%`)}
            />
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <Button size="lg" disabled={busy || !!t.actual_start} onClick={() => quick({ actual_start: today, status: 'IN_PROGRESS' }, `Started ${t.title} today`)}>
                Started today
              </Button>
              <Button size="lg" disabled={busy || !!t.actual_finish} onClick={() => quick({ actual_finish: today, actual_start: t.actual_start ?? today, pct_complete: 1, status: 'DONE' }, `Finished ${t.title} today`)}>
                Finished today
              </Button>
              <Button size="lg" disabled={busy || !!t.actual_start} onClick={() => p.onPush(1)}>
                Push 1 day
              </Button>
              <Button size="lg" disabled={busy || !!t.actual_start} onClick={() => p.onPush(5)}>
                Push 1 week
              </Button>
            </div>
          </div>
        </PanelSection>
      )}

      <PanelSection title={leaf ? 'Task' : 'Phase'}>
        <div className="stack" style={{ gap: 8 }}>
          <Field label="Name">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} disabled={ro} />
          </Field>
          {leaf && (
            <>
              <Field label="Status">
                <Select value={t.status} disabled={ro || busy} onChange={(e) => quick({ status: e.target.value as TaskStatus }, `Marked ${t.title} ${e.target.value === 'DONE' ? 'done' : e.target.value.toLowerCase().replace('_', ' ')}`)}>
                  <option value="TODO">To do</option>
                  <option value="IN_PROGRESS">In progress</option>
                  <option value="BLOCKED">Blocked</option>
                  <option value="DONE">Done</option>
                  <option value="CANCELLED">Cancelled</option>
                </Select>
              </Field>
              <Field label="Percent complete" help="0 to 100">
                <Input value={pct} onChange={(e) => setPct(e.target.value)} inputMode="numeric" disabled={ro} />
              </Field>
              <div className="row" style={{ gap: 8 }}>
                <Field label="Actual start">
                  <Input value={aStart} onChange={(e) => setAStart(e.target.value)} placeholder="11/18" disabled={ro} />
                </Field>
                <Field label="Actual finish">
                  <Input value={aFinish} onChange={(e) => setAFinish(e.target.value)} placeholder="11/20" disabled={ro} />
                </Field>
              </div>
              <Field label="Crew">
                <Select value={t.assigned_crew_id ?? ''} disabled={ro || busy} onChange={(e) => quick({ assigned_crew_id: e.target.value || null }, e.target.value ? `Assigned ${crews.find((c) => c.id === e.target.value)?.name ?? 'the crew'}` : 'Removed the crew')}>
                  <option value="">No crew</option>
                  {crews.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="row" style={{ gap: 8 }}>
                <Field label="Constraint">
                  <Select value={ctype} onChange={(e) => setCtype(e.target.value as ConstraintType)} disabled={ro}>
                    {CONSTRAINT_TYPES.map((c) => (
                      <option key={c} value={c}>
                        {CONSTRAINT_LABEL[c]}
                      </option>
                    ))}
                  </Select>
                </Field>
                {ctype !== 'ASAP' && (
                  <Field label="Constraint date">
                    <Input value={cdate} onChange={(e) => setCdate(e.target.value)} placeholder="11/18" disabled={ro} />
                  </Field>
                )}
              </div>
              <Field label="Predecessors" help="Row numbers with type and lag: 12FS+2d, 14SS" error={linkErr ?? undefined}>
                <Input value={links} onChange={(e) => setLinks(e.target.value)} disabled={ro} />
              </Field>
            </>
          )}
          {err && <span className="field-error" role="alert">{err}</span>}
        </div>
      </PanelSection>

      <PanelSection title="Links" meta={<span className="t-cap">{preds.length} before · {succs.length} after</span>}>
        {preds.length + succs.length === 0 ? (
          <p className="t-cap">No links yet. Type predecessors above, or drag from a bar’s end dot to the task that follows.</p>
        ) : (
          <ul className="stack" style={{ gap: 4, listStyle: 'none', padding: 0, margin: 0 }}>
            {[...preds.map((d) => ({ d, other: d.pred_id, dir: 'After' })), ...succs.map((d) => ({ d, other: d.succ_id, dir: 'Before' }))].map(({ d, other, dir }) => {
              const o = byId.get(other);
              return (
                <li key={`${d.pred_id}>${d.succ_id}`}>
                  <button type="button" className="nlink" onClick={() => p.onSelect(other)} style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', textAlign: 'left' }}>
                    {dir} {o ? `#${o.rowNo} ${o.task.title}` : 'a task not loaded'}
                  </button>
                  <span className="t-cap"> · {DEP_WORDS[d.dep_type]}{d.lag_days ? `, ${d.lag_days > 0 ? '+' : '−'}${days(Math.abs(d.lag_days))}` : ''}</span>
                </li>
              );
            })}
          </ul>
        )}
      </PanelSection>

      <ConfirmDialog
        open={confirmDel}
        onClose={() => setConfirmDel(false)}
        tone="danger"
        title="Remove this task"
        confirmLabel="Remove task"
        onConfirm={async () => {
          await p.onDelete();
        }}
      >
        {t.title}
        {succs.length ? ` — ${succs.length} task${succs.length === 1 ? '' : 's'} after it lose this link and may move earlier.` : ''}
      </ConfirmDialog>
    </Panel>
  );
}

/** The day `n` working days after a task's start (Push 1 day / 1 week). */
export function pushedStart(cal: WorkCalendar, start: string, n: number): string {
  return addWorkdays(cal, addWorkdays(cal, start, 0), n);
}
