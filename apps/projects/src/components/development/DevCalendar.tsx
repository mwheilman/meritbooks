'use client';

import { useMemo, useState } from 'react';
import { AppLink, Button, Field, Input, Select, Status, type StatusKind } from '@meritbooks/merit-ui';
import type { CalendarItem } from '@/app/api/development/calendar/route';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, Section } from '@/components/ops/common/bits';
import { BoardState, Empty, day, useBoard, useDo } from '@/components/dealer/common/depth';

const SOURCES: Array<[CalendarItem['source'] | 'ALL', string]> = [['ALL', 'Everything'], ['KEY_DATE', 'Key dates'], ['COVENANT', 'Covenants'], ['ENTITLEMENT', 'Entitlements'], ['CONDITION', 'Conditions'], ['PURSUIT', 'Pursuits']];

const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/** Key dates and the covenant calendar (RED-06) across every SPE: PSA, loan, covenant tests, hearings, conditions and pursuit hard dates. */
export function DevCalendar({ companyId, today }: { companyId: string; today: string }) {
  const { readOnly } = useShell();
  const [from, setFrom] = useState(addDays(today, -30));
  const [to, setTo] = useState(addDays(today, 180));
  const [src, setSrc] = useState<CalendarItem['source'] | 'ALL'>('ALL');
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;
  const b = useBoard<{ from: string; to: string; items: CalendarItem[] }>(ok ? `/api/development/calendar?company=${companyId}&from=${from}&to=${to}` : null);
  const { run, busy, error } = useDo(b.reload);
  const items = useMemo(() => (b.data?.items ?? []).filter((i) => src === 'ALL' || i.source === src), [b.data, src]);
  const overdue = items.filter((i) => i.overdue).length;
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      <div className="ops-toolbar">
        <Field label="From" error={ok ? undefined : 'From must be on or before To'}><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <Field label="Show"><Select value={src} onChange={(e) => setSrc(e.target.value as CalendarItem['source'] | 'ALL')}>{SOURCES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
        {!readOnly && <Button disabled={busy === 'rem'} onClick={() => run('rem', '/api/development/calendar', { companyId }, (r: { notified: number }) => `${r.notified} reminder(s) sent`)}>Send today’s reminders</Button>}
      </div>
      <BoardState b={b} what="Key dates" />
      {b.data && (items.length === 0 ? <Empty title="Nothing in this window" body="PSA and loan dates, covenant tests, hearings, permit expirations and entitlement conditions show here; each sends a reminder ahead of its date." /> :
        <Section title={`${items.length} date(s)`} meta={overdue ? `${overdue} past due` : 'Nothing past due'}>
          <ul className="ops-agenda">{items.map((i) => {
            const k: StatusKind = i.overdue ? 'overdue' : i.in_window ? 'risk' : 'track';
            return <li key={`${i.source}-${i.id}`}><span className="d">{day(i.due_on, today)}</span>
              <span>{i.job_id ? <AppLink href={`/development/${i.job_id}/oversight`}>{i.job_number ?? 'Project'}</AppLink> : i.pursuit_id ? <AppLink href="/development/pursuits">Pursuit</AppLink> : null} {i.label}
                {' '}<Status kind={k} pip="open">{i.overdue ? 'past due' : i.status.toLowerCase().replace(/_/g, ' ')}</Status> <span className="l2">{i.source.toLowerCase().replace(/_/g, ' ')} · {i.kind.toLowerCase().replace(/_/g, ' ')}</span></span></li>;
          })}</ul>
        </Section>)}
    </div>
  );
}
