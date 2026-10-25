'use client';

import { useState } from 'react';
import { Button, Field, Input, Select, Tag, Textarea, shortDate } from '@meritbooks/merit-ui';
import type { HomeWorkspace } from '@/lib/residential/queries';
import type { WalkRow } from '@/lib/residential/types';
import { WALK_WORDS } from '@/lib/residential/labels';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, Section } from '@/components/ops/common/bits';
import { useOps } from '@/components/ops/common/useOps';

export function HomeCloseout({ bundle: b, today, canEdit }: { bundle: HomeWorkspace; today: string; canEdit: boolean }) {
  const { readOnly } = useShell();
  const edit = canEdit && !readOnly;
  const { act, busy, error } = useOps();
  const jobUrl = `/api/residential/jobs/${b.job!.id}`;
  const [actual, setActual] = useState<Record<string, string>>({});
  const [walkKind, setWalkKind] = useState<'FINAL_WALKTHROUGH' | 'ORIENTATION' | 'CUSTOM'>('FINAL_WALKTHROUGH');
  const [walkDue, setWalkDue] = useState('');
  const hasWarranty = b.walks.some((w) => w.kind.startsWith('WARRANTY'));
  return (
    <div className="stack">
      <Failure text={error} />
      <Section title="Cabinets and countertops" meta="Each step’s actual date re-plans the rest; the homeowner sees the friendly labels"
        actions={edit && b.chainSteps.length === 0 ? <Button disabled={busy === 'chain'} onClick={() => void act('chain', 'post', jobUrl, { op: 'chain_create' }, 'Chain started')}>Start the chain</Button> : undefined}>
        {b.chainSteps.length === 0 ? <p className="t-cap">Order → deliver → install cabinets → template → fabricate → install tops → backsplash → plumbing reconnect, with each lead time.</p> : (
          <div className="mp-table">
            <table className="tbl tbl-q tbl-q--compact">
              <thead><tr><th>Step</th><th>Lead</th><th>Planned</th><th>Done</th><th aria-label="Record" /></tr></thead>
              <tbody>
                {b.chainSteps.map((s) => (
                  <tr key={s.id}>
                    <td><span className="l1">{s.label}</span>{s.homeowner_visible && s.homeowner_label && <span className="l2">Homeowner sees: {s.homeowner_label}</span>}</td>
                    <td>{s.lead_days} d</td>
                    <td>{s.planned_on ? shortDate(s.planned_on, today) : '—'}</td>
                    <td>{s.actual_on ? shortDate(s.actual_on, today) : s.status === 'SKIPPED' ? 'Skipped' : '—'}</td>
                    <td className="n">
                      {edit && s.status !== 'DONE' && s.status !== 'SKIPPED' && (
                        <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                          <Input type="date" aria-label={`${s.label} done on`} value={actual[s.id] ?? today} onChange={(e) => setActual((a) => ({ ...a, [s.id]: e.target.value }))} style={{ width: 150 }} />
                          <Button disabled={busy === s.id} onClick={() => void act(s.id, 'post', jobUrl, { op: 'chain_advance', stepId: s.id, actualOn: actual[s.id] ?? today }, `${s.label} done — the rest re-planned`)}>Done</Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Walkthroughs and warranty" meta="Items found on a walk become punch items for the right trade"
        actions={edit ? (
          <div className="btn-row">
            {!hasWarranty && <Button disabled={busy === 'warranty'} onClick={() => void act<{ scheduled: number }>('warranty', 'post', jobUrl, { op: 'warranty_walks', from: today }, (d) => `${d.scheduled} warranty walks scheduled (30 days, 11 months, 2 years)`)}>Schedule warranty walks</Button>}
          </div>
        ) : undefined}>
        {b.walks.length === 0 ? <p className="t-cap">No walks yet.</p> : b.walks.map((w) => <Walk key={w.id} walk={w} jobUrl={jobUrl} edit={edit} today={today} />)}
        {edit && (
          <form className="mp-form-2" style={{ marginTop: 12, gridTemplateColumns: '1fr 1fr auto', alignItems: 'end' }} onSubmit={(e) => {
            e.preventDefault();
            void act('walk', 'post', jobUrl, { op: 'walk_plan', kind: walkKind, dueOn: walkDue || null }, 'Walk planned');
          }}>
            <Field label="Plan a walk"><Select value={walkKind} onChange={(e) => setWalkKind(e.target.value as typeof walkKind)}><option value="FINAL_WALKTHROUGH">Final walkthrough</option><option value="ORIENTATION">Homeowner orientation</option><option value="CUSTOM">Other walk</option></Select></Field>
            <Field label="On"><Input type="date" value={walkDue} onChange={(e) => setWalkDue(e.target.value)} /></Field>
            <Button type="submit" disabled={busy === 'walk'}>Plan</Button>
          </form>
        )}
      </Section>
    </div>
  );
}

function Walk({ walk: w, jobUrl, edit, today }: { walk: WalkRow; jobUrl: string; edit: boolean; today: string }) {
  const { act, busy } = useOps();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState('');
  const [by, setBy] = useState('');
  const late = w.status !== 'DONE' && !!w.due_on && w.due_on < today;
  const complete = () => {
    const list = items.split('\n').map((t) => t.trim()).filter(Boolean).map((t) => {
      const [title, location] = t.split(' @ ');
      return { title: title!.slice(0, 200), location: location?.slice(0, 120) ?? null };
    });
    void act<{ punch_created: number }>(w.id, 'post', jobUrl, { op: 'walk_complete', walkId: w.id, acceptedBy: by.trim() || null, items: list }, (d) => `Walk done — ${d.punch_created} punch items`).then((r) => { if (r) setOpen(false); });
  };
  return (
    <div style={{ borderTop: '1px solid var(--line)', padding: '8px 0' }}>
      <div className="row" style={{ gap: 8 }}>
        <span className="b">{WALK_WORDS[w.kind]}</span>
        <span className={late ? 'neg b' : 't-cap'}>{w.due_on ? shortDate(w.due_on, today) : 'No date'}</span>
        {w.status === 'DONE' ? <Tag tone="pos">Done · {w.punch_created} punch items{w.accepted_by_name ? ` · accepted by ${w.accepted_by_name}` : ''}</Tag> : late ? <Tag tone="neg">Overdue</Tag> : <Tag>{w.status.toLowerCase()}</Tag>}
        <span className="sp" />
        {edit && w.status !== 'DONE' && w.status !== 'SKIPPED' && <Button variant="quiet" onClick={() => setOpen(!open)}>{open ? 'Close' : 'Record the walk'}</Button>}
      </div>
      {open && (
        <div className="mp-form" style={{ marginTop: 8 }}>
          <Field label="Items found" help="One per line; add “ @ room” to place it"><Textarea value={items} onChange={(e) => setItems(e.target.value)} rows={5} placeholder={'Cabinet door rubs @ Kitchen\nGrout haze @ Primary bath'} /></Field>
          <Field label="Accepted by (homeowner)"><Input value={by} onChange={(e) => setBy(e.target.value)} maxLength={200} /></Field>
          <div className="btn-row"><span className="sp" /><Button variant="primary" disabled={busy === w.id} onClick={complete}>Complete walk</Button></div>
        </div>
      )}
    </div>
  );
}
