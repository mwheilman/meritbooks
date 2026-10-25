'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Button, ButtonLink, Drawer, Figure, KV, Seg, Tag, money } from '@meritbooks/merit-ui';
import { addDaysIso, calendarState, monthGrid, type CalendarRow, type CalendarState } from '@/lib/commercial/screen-logic';
import { useMoneyVis } from '@/components/shell/ShellContext';
import { cm, day } from './common';
import { CmTable, TableKeys, words, type Col } from './kit';

type Row = CalendarRow & { location_id: string };
type View = 'calendar' | 'list' | 'by-gc';
const STATE_WORD: Readonly<Record<CalendarState, { word: string; tone?: 'pos' | 'neg' | 'warn' }>> = {
  PAID: { word: 'Paid', tone: 'pos' }, APPROVED: { word: 'Approved', tone: 'pos' }, SUBMITTED: { word: 'Submitted' }, PENCIL: { word: 'Pencil drafted' },
  LATE: { word: 'Cutoff passed', tone: 'neg' }, DUE_SOON: { word: 'Pencil due soon', tone: 'warn' }, NOT_STARTED: { word: 'Not started' },
};
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export interface GcRollup { gc: string; jobs: number; retainage: number; billed: number; late: number }

/** Retainage and billing by GC / owner across the jobs on the calendar. Pure. */
export function byGc(rows: ReadonlyArray<Row>, billed: Readonly<Record<string, { billed: number }>>, today: string): GcRollup[] {
  const m = new Map<string, GcRollup>();
  for (const r of rows) {
    const k = r.customer_name ?? 'No customer';
    const g = m.get(k) ?? { gc: k, jobs: 0, retainage: 0, billed: 0, late: 0 };
    g.jobs += 1;
    g.retainage += Number(r.retainage_outstanding_cents ?? 0);
    g.billed += billed[r.job_id]?.billed ?? 0;
    if (calendarState(r, today) === 'LATE') g.late += 1;
    m.set(k, g);
  }
  return [...m.values()].sort((a, b) => b.retainage - a.retainage || a.gc.localeCompare(b.gc));
}

/**
 * The sub's multi-GC billing calendar (CGC-102): every job's cutoff, pencil-due date, form and
 * portal (Textura, GCPay, Procore Pay, the GC's own form) on one calendar, with where this
 * period stands — pencil, submitted, approved, paid — and retainage and billing by GC.
 */
export function BillingCalendarView({ rows, billed, today }: { rows: Row[]; billed: Readonly<Record<string, { billed: number; last: string | null }>>; today: string }) {
  const mv = useMoneyVis();
  const [view, setView] = useState<View>('calendar');
  const [month, setMonth] = useState(today.slice(0, 7));
  const [openId, setOpenId] = useState<string | null>(null);
  const byId = useMemo(() => new Map(rows.map((r) => [r.job_id, r])), [rows]);
  const grid = useMemo(() => monthGrid(month, rows), [month, rows]);
  const gcs = byGc(rows, billed, today);
  const open = openId ? byId.get(openId) ?? null : null;
  const late = rows.filter((r) => calendarState(r, today) === 'LATE');
  const soon = rows.filter((r) => { const s = calendarState(r, today); return s === 'DUE_SOON' || (s === 'NOT_STARTED' && r.pencil_due <= addDaysIso(today, 7)); });
  const label = (r: Row) => [r.job_number, r.job_name].filter(Boolean).join(' · ');
  const moveMonth = (n: number) => { const [y, m] = month.split('-').map(Number) as [number, number]; const d = new Date(Date.UTC(y, m - 1 + n, 1)); setMonth(d.toISOString().slice(0, 7)); };

  const cols: Col<Row>[] = [
    { key: 'j', head: 'Job', cell: (r) => <><span className="b">{label(r)}</span><span className="ops-sub" style={{ display: 'block' }}>{r.customer_name ?? '—'}</span></> },
    { key: 'f', head: 'Form and portal', width: 170, cell: (r) => <>{words(r.billing_form)}{r.billing_portal_url && <span className="ops-sub" style={{ display: 'block' }}>Portal on file</span>}</> },
    { key: 'p', head: 'Pencil due', width: 120, cell: (r) => day(r.pencil_due, today) },
    { key: 'c', head: 'Cutoff', width: 120, cell: (r) => <>{day(r.next_cutoff, today)}<span className="ops-sub" style={{ display: 'block' }}>the {r.billing_cutoff_day}{[1, 21, 31].includes(r.billing_cutoff_day) ? 'st' : [2, 22].includes(r.billing_cutoff_day) ? 'nd' : [3, 23].includes(r.billing_cutoff_day) ? 'rd' : 'th'}</span></> },
    { key: 's', head: 'This period', width: 160, cell: (r) => { const s = STATE_WORD[calendarState(r, today)]; return <Tag tone={s.tone}>{s.word}</Tag>; } },
    { key: 'r', head: 'Retainage held', n: true, width: 140, hidden: !mv.contract, cell: (r) => cm(r.retainage_outstanding_cents, 0) },
  ];
  const gcols: Col<GcRollup>[] = [
    { key: 'g', head: 'GC or owner', cell: (g) => <span className="b">{g.gc}</span> },
    { key: 'j', head: 'Jobs', n: true, width: 80, cell: (g) => g.jobs },
    { key: 'l', head: 'Past cutoff', n: true, width: 110, cell: (g) => (g.late ? <span className="neg">{g.late}</span> : '—') },
    { key: 'b', head: 'Billed to date', n: true, width: 150, hidden: !mv.contract, cell: (g) => money(g.billed, { decimals: 0 }) },
    { key: 'r', head: 'Retainage held', n: true, width: 150, hidden: !mv.contract, cell: (g) => money(g.retainage, { decimals: 0 }) },
  ];

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="cm-figs">
        <Figure dense label="Pencils due this week" value={String(soon.length)} vs={[`${late.length} past the cutoff with nothing submitted`, `${rows.length} jobs billing`]} href="/pay-apps" linkLabel="Pay applications" />
        {mv.contract && <Figure dense label="Retainage held by GCs" value={money(rows.reduce((s, r) => s + Number(r.retainage_outstanding_cents ?? 0), 0), { decimals: 0 })} vs={[`across ${gcs.length} GCs and owners`]} href="/retainage-ledger?tab=by-customer" linkLabel="Retainage ledger" />}
      </div>
      <div className="ops-toolbar">
        <Seg aria-label="View" value={view} onChange={setView} items={[{ value: 'calendar', label: 'Calendar' }, { value: 'list', label: 'By job', count: rows.length }, { value: 'by-gc', label: 'By GC', count: gcs.length }]} />
        <span className="sp" />
        {view === 'calendar' && <><Button variant="quiet" chord="[" bindChord onClick={() => moveMonth(-1)}>Previous month</Button><b className="tnum">{month}</b><Button variant="quiet" chord="]" bindChord onClick={() => moveMonth(1)}>Next month</Button></>}
      </div>
      {view === 'calendar' && (
        rows.length === 0 ? <CmTable label="Billing calendar" rows={[]} cols={cols} rowKey={(r) => r.job_id} empty={{ title: 'No jobs on the calendar', body: 'A job appears once its contract settings have a billing cutoff day (set by its project template).' }} /> : (
          <div className="cm-cal" role="grid" aria-label={`Billing calendar ${month}`}>
            {DOW.map((d) => <div key={d} className="h" role="columnheader">{d}</div>)}
            {grid.map((d) => (
              <div key={d.date} role="gridcell" className={['d', d.inMonth ? null : 'out', d.date === today ? 'today' : null].filter(Boolean).join(' ')}>
                <span className="num">{Number(d.date.slice(8))}</span>
                {d.cutoffs.map((id) => { const r = byId.get(id); return r ? <button key={`c${id}`} type="button" className="ev cut" onClick={() => setOpenId(id)}>Cutoff · {r.job_number ?? r.job_name}</button> : null; })}
                {d.pencils.map((id) => { const r = byId.get(id); return r ? <button key={`p${id}`} type="button" className="ev pen" onClick={() => setOpenId(id)}>Pencil · {r.job_number ?? r.job_name}</button> : null; })}
              </div>
            ))}
          </div>
        )
      )}
      {view === 'list' && <CmTable label="Billing by job" keys rows={rows} cols={cols} rowKey={(r) => r.job_id} onOpen={(r) => setOpenId(r.job_id)} activeId={openId}
        rowTone={(r) => (calendarState(r, today) === 'LATE' ? 'neg' : calendarState(r, today) === 'DUE_SOON' ? 'warn' : null)}
        empty={{ title: 'No jobs on the calendar', body: 'A job appears once its contract settings have a billing cutoff day (set by its project template).' }} />}
      {view === 'by-gc' && <CmTable label="Billing by GC" keys rows={gcs} cols={gcols} rowKey={(g) => g.gc} empty={{ title: 'No GCs yet', body: 'Each GC or owner you bill shows here with retainage they hold.' }} />}
      {view !== 'calendar' && <TableKeys />}
      <Drawer open={!!open} onClose={() => setOpenId(null)} width={460} title={open ? label(open) : ''} eyebrow={open?.customer_name ?? undefined}>
        {open && (
          <div className="stack" style={{ gap: 16 }}>
            <KV items={[
              { term: 'This period', value: STATE_WORD[calendarState(open, today)].word }, { term: 'Pencil due', value: day(open.pencil_due, today) }, { term: 'Cutoff', value: day(open.next_cutoff, today) },
              { term: 'Form', value: words(open.billing_form) }, { term: 'Pay app stage', value: words(open.current_stage) }, { term: 'Portal status', value: words(open.portal_status) },
              ...(mv.contract ? [{ term: 'Retainage held', value: cm(open.retainage_outstanding_cents) }, { term: 'Billed to date', value: money(billed[open.job_id]?.billed ?? 0) }] : []),
              { term: 'Last billed', value: day(billed[open.job_id]?.last ?? null, today) },
            ]} />
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <ButtonLink variant="primary" href="/pay-apps">Pay applications</ButtonLink>
              <ButtonLink href={`/jobs/${open.job_id}?tab=billing`}>Job billing</ButtonLink>
              {open.billing_portal_url && <a className="btn" href={open.billing_portal_url} target="_blank" rel="noreferrer">Open the GC’s portal</a>}
            </div>
            <p className="t-cap">Cutoff and pencil lead time come from the job’s contract settings. <Link className="link" href="/project-templates">Project templates</Link></p>
          </div>
        )}
      </Drawer>
    </div>
  );
}
