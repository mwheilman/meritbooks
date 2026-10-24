/**
 * Schedule export: CSV (spreadsheets) and Microsoft Project XML (MSPDI, opens in Project and
 * most schedulers). Primavera P6 XER and both imports are the next slice (spec §1.11).
 * Billing amounts are written only when the caller may see them. Pure.
 */
import { formatLinks } from './links';
import type { OutlineRow } from './tree';
import type { BaselineTask, SchedDep, SchedTask, WorkCalendar } from './types';

export interface ExportInput {
  jobLabel: string;
  rows: ReadonlyArray<OutlineRow>;
  deps: ReadonlyArray<SchedDep>;
  crewName: (id: string | null) => string | null;
  baseline?: ReadonlyMap<string, BaselineTask>;
  /** projects.contract_value at the job's company. */
  includeBilling: boolean;
}

function csvCell(v: string | number | null | undefined): string {
  if (v == null) return '';
  const s = String(v);
  // a leading = + - @ would run as a formula in a spreadsheet
  const safe = /^[=+\-@]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const pct = (x: number | null) => (x == null ? '' : String(Math.round(x * 100)));

export function scheduleCsv(x: ExportInput): string {
  const byId = new Map(x.rows.map((r) => [r.task.id, r]));
  const predsOf = new Map<string, SchedDep[]>();
  for (const d of x.deps) {
    const l = predsOf.get(d.succ_id);
    if (l) l.push(d);
    else predsOf.set(d.succ_id, [d]);
  }
  const head = ['#', 'WBS', 'Task', 'Duration (working days)', 'Start', 'Finish', '% complete', 'Status', 'Crew', 'Predecessors', 'Total float', 'Critical', 'Milestone', 'Actual start', 'Actual finish'];
  if (x.baseline) head.push('Baseline start', 'Baseline finish');
  if (x.includeBilling) head.push('Billing amount');
  const lines = [head.map(csvCell).join(',')];
  for (const r of x.rows) {
    const t = r.task;
    const preds = formatLinks(predsOf.get(t.id) ?? [], (id) => (byId.get(id) ? String(byId.get(id)!.rowNo) : null), (id) => byId.get(id)?.rowNo ?? 0);
    const cells: Array<string | number | null> = [
      r.rowNo, r.wbs, `${'  '.repeat(r.depth)}${t.title}`, t.is_milestone ? 0 : t.duration_days, t.start_on, t.due_on, pct(t.pct_complete), t.status,
      x.crewName(t.assigned_crew_id), preds, t.total_float, t.is_critical ? 'Yes' : 'No', t.is_milestone ? 'Yes' : 'No', t.actual_start, t.actual_finish,
    ];
    if (x.baseline) {
      const b = x.baseline.get(t.id);
      cells.push(b?.start_on ?? null, b?.due_on ?? null);
    }
    if (x.includeBilling) cells.push(t.billing_amount_cents == null ? null : (t.billing_amount_cents / 100).toFixed(2));
    lines.push(cells.map(csvCell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** MSPDI link types: 0 FF, 1 FS, 2 SF, 3 SS. */
const MSP_TYPE: Readonly<Record<SchedDep['dep_type'], number>> = { FF: 0, FS: 1, SF: 2, SS: 3 };

export function scheduleMspXml(x: ExportInput & { calendar: WorkCalendar; start: string | null }): string {
  const uid = new Map(x.rows.map((r, i) => [r.task.id, i + 1]));
  const predsOf = new Map<string, SchedDep[]>();
  for (const d of x.deps) {
    const l = predsOf.get(d.succ_id);
    if (l) l.push(d);
    else predsOf.set(d.succ_id, [d]);
  }
  const hpd = x.calendar.hours_per_day || 8;
  const at = (iso: string | null, end: boolean) => (iso ? `${iso}T${end ? '17:00:00' : '08:00:00'}` : '');
  const task = (r: OutlineRow) => {
    const t: SchedTask = r.task;
    const d = t.is_milestone ? 0 : t.duration_days ?? 0;
    const links = (predsOf.get(t.id) ?? [])
      .filter((p) => uid.has(p.pred_id))
      .map((p) => `<PredecessorLink><PredecessorUID>${uid.get(p.pred_id)}</PredecessorUID><Type>${MSP_TYPE[p.dep_type]}</Type><LinkLag>${p.lag_days * hpd * 600}</LinkLag><LagFormat>7</LagFormat></PredecessorLink>`)
      .join('');
    return [
      '<Task>',
      `<UID>${uid.get(t.id)}</UID><ID>${r.rowNo}</ID><Name>${xmlEsc(t.title)}</Name>`,
      `<WBS>${xmlEsc(r.wbs)}</WBS><OutlineNumber>${xmlEsc(r.wbs)}</OutlineNumber><OutlineLevel>${r.depth + 1}</OutlineLevel>`,
      `<Summary>${r.hasChildren ? 1 : 0}</Summary><Milestone>${t.is_milestone ? 1 : 0}</Milestone><Critical>${t.is_critical ? 1 : 0}</Critical>`,
      t.start_on ? `<Start>${at(t.start_on, false)}</Start>` : '',
      t.due_on ? `<Finish>${at(t.due_on, true)}</Finish>` : '',
      `<Duration>PT${d * hpd}H0M0S</Duration><DurationFormat>7</DurationFormat>`,
      `<PercentComplete>${Math.round((t.pct_complete ?? 0) * 100)}</PercentComplete>`,
      t.actual_start ? `<ActualStart>${at(t.actual_start, false)}</ActualStart>` : '',
      t.actual_finish ? `<ActualFinish>${at(t.actual_finish, true)}</ActualFinish>` : '',
      t.constraint_type !== 'ASAP' && t.constraint_date
        ? `<ConstraintType>${t.constraint_type === 'MSO' ? 2 : t.constraint_type === 'SNET' ? 4 : 7}</ConstraintType><ConstraintDate>${at(t.constraint_date, t.constraint_type === 'FNLT')}</ConstraintDate>`
        : '',
      links,
      '</Task>',
    ].join('');
  };
  const weekDays = [1, 2, 3, 4, 5, 6, 7]
    .map((iso) => {
      const mspDay = (iso % 7) + 1; // MSPDI: 1 = Sunday … 7 = Saturday
      const working = x.calendar.workdays.includes(iso);
      return `<WeekDay><DayType>${mspDay}</DayType><DayWorking>${working ? 1 : 0}</DayWorking>${working ? '<WorkingTimes><WorkingTime><FromTime>08:00:00</FromTime><ToTime>12:00:00</ToTime></WorkingTime><WorkingTime><FromTime>13:00:00</FromTime><ToTime>17:00:00</ToTime></WorkingTime></WorkingTimes>' : ''}</WeekDay>`;
    })
    .join('');
  const exceptions = Object.entries(x.calendar.exceptions)
    .filter(([, w]) => !w)
    .map(([day]) => `<WeekDay><DayType>0</DayType><DayWorking>0</DayWorking><TimePeriod><FromDate>${day}T00:00:00</FromDate><ToDate>${day}T23:59:00</ToDate></TimePeriod></WeekDay>`)
    .join('');
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Project xmlns="http://schemas.microsoft.com/project">',
    `<Name>${xmlEsc(x.jobLabel)}</Name><Title>${xmlEsc(x.jobLabel)}</Title>`,
    x.start ? `<StartDate>${at(x.start, false)}</StartDate>` : '',
    `<MinutesPerDay>${hpd * 60}</MinutesPerDay><MinutesPerWeek>${hpd * 60 * x.calendar.workdays.length}</MinutesPerWeek><CalendarUID>1</CalendarUID>`,
    `<Calendars><Calendar><UID>1</UID><Name>${xmlEsc(x.calendar.name)}</Name><IsBaseCalendar>1</IsBaseCalendar><WeekDays>${weekDays}${exceptions}</WeekDays></Calendar></Calendars>`,
    `<Tasks>${x.rows.map(task).join('')}</Tasks>`,
    '</Project>',
    '',
  ].join('\n');
}

/** "1042 Smith kitchen" → "1042-smith-kitchen-schedule.csv" */
export function exportFileName(jobLabel: string, ext: 'csv' | 'xml'): string {
  const slug = jobLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'job';
  return `${slug}-schedule.${ext}`;
}
