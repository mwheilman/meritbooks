'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Button, Check, InlineNotice, Status, Tag, WidgetState, count } from '@meritbooks/merit-ui';
import { useShell } from '@/components/shell/ShellContext';
import type { TimesheetDay } from '@/lib/fieldservice/completion-types';
import { useAction, words } from '../common/useAction';

export interface TimesheetReviewProps {
  days: TimesheetDay[];
  error: string | null;
  from: string;
  to: string;
  canApprove: boolean;
}

/**
 * Timesheet review (FS-102): each tech's days with the exceptions a service manager checks before
 * approving — long drives, unexplained gaps, overtime, missing clock-outs, finished visits with no
 * time — and the fix the rules propose. Clean submitted days can be approved in one go; approval
 * goes through the approval engine (preparer ≠ approver).
 */
export function TimesheetReview(p: TimesheetReviewProps) {
  const { readOnly } = useShell();
  const { run, busy, error } = useAction();
  const [only, setOnly] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const rows = useMemo(() => (only ? p.days.filter((d) => d.flags.length > 0 || d.submitted_ids.length > 0) : p.days), [p.days, only]);
  const cleanSubmitted = p.days.filter((d) => d.clean && d.submitted_ids.length > 0);
  const toggle = (key: string) => setPicked((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const ids = (keys: Iterable<string>) => [...keys].flatMap((k) => p.days.find((d) => `${d.employee_id}:${d.day}` === k)?.submitted_ids ?? []);
  const approve = (entryIds: string[]) => run<{ approved: number; pending: number }>('approve', '/api/fieldservice/timesheets', { op: 'approve', entryIds },
    (r) => `${count(r.approved)} approved${r.pending ? `, ${count(r.pending)} waiting on another step` : ''}`).then(() => setPicked(new Set()));

  if (p.error) return <WidgetState state={{ kind: 'error', title: 'Timesheets did not load', body: p.error }} />;
  return (
    <div className="stack">
      {error && <InlineNotice tone="neg" title="Not approved.">{error}</InlineNotice>}
      <div className="fs-toolbar">
        <div className="fs-flags" role="group" aria-label="Period">
          <Link className="btn btn--quiet" href="/dispatch/timesheets">This week</Link>
          <Link className="btn btn--quiet" href="/dispatch/timesheets?weeks=2">Two weeks</Link>
        </div>
        <Check label="Only days that need a look" checked={only} onChange={(e) => setOnly(e.target.checked)} />
        <span className="sp" />
        {p.canApprove && !readOnly && <>
          <Button disabled={picked.size === 0 || !!busy} onClick={() => void approve(ids(picked))}>{`Approve selected (${count(ids(picked).length)})`}</Button>
          <Button variant="primary" disabled={cleanSubmitted.length === 0 || !!busy} onClick={() => void approve(cleanSubmitted.flatMap((d) => d.submitted_ids))}>
            {`Approve all clean days (${count(cleanSubmitted.length)})`}</Button>
        </>}
      </div>
      {rows.length === 0 ? <WidgetState state={{ kind: 'done', title: 'Nothing to review', body: `No time or exceptions between ${p.from} and ${p.to}.` }} /> : (
        <section className="fs-card" aria-label="Timesheets">
          <table className="fs-table">
            <thead><tr><th aria-label="Pick" /><th>Technician</th><th>Day</th><th className="n">Hours</th><th>Entries</th><th>Exceptions and the proposed fix</th></tr></thead>
            <tbody>{rows.map((d) => {
              const key = `${d.employee_id}:${d.day}`;
              return (
                <tr key={key} aria-selected={picked.has(key)}>
                  <td>{d.submitted_ids.length > 0 && p.canApprove && !readOnly && <Check aria-label={`Pick ${d.employee} ${d.day}`} checked={picked.has(key)} onChange={() => toggle(key)} />}</td>
                  <td>{d.employee}</td>
                  <td className="fs-mono">{d.day}</td>
                  <td className="n">{d.hours > 8 ? <Status kind="risk">{`${d.hours}`}</Status> : d.hours}</td>
                  <td><span className="fs-flags">{d.entries.map((e) => <Tag key={e.id} tone={e.state === 'APPROVED' ? 'pos' : e.state === 'SUBMITTED' ? 'ai' : 'default'}>{`${e.hours} h ${words(e.state)}`}</Tag>)}</span></td>
                  <td>{d.clean ? <Tag tone="pos">Clean</Tag> : (
                    <ul className="fs-list" style={{ margin: 0 }}>{d.flags.map((f, i) => (
                      <li key={i} style={{ padding: '2px 0', border: 0, display: 'block' }}><b>{f.message}.</b> <span className="t-cap">{f.fix}</span></li>
                    ))}</ul>
                  )}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </section>
      )}
    </div>
  );
}
