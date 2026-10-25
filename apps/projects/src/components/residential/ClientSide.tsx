'use client';

import { useEffect, useState } from 'react';
import { Button, Field, Select, Status, Textarea, count } from '@meritbooks/merit-ui';
import type { ClientUpdateRow, CloseoutItemRow, DateChangeRow } from '@/app/api/residential/jobs/[jobId]/client/route';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, Section } from '@/components/ops/common/bits';
import { BoardState, Empty, day, useBoard, useDo } from '@/components/dealer/common/depth';

interface Data { changes: DateChangeRow[]; updates: ClientUpdateRow[]; closeout: { id: string; status: string; title: string; published_at: string | null; items: CloseoutItemRow[] } | null; clientVisibleTasks: number }

const REASONS = [['WEATHER', 'Weather'], ['INSPECTION', 'Waiting on inspection'], ['MATERIAL', 'Material late'], ['SELECTION', 'Waiting on a selection'],
  ['TRADE', 'Trade rescheduled'], ['CHANGE_ORDER', 'Change order added work'], ['HOMEOWNER', 'Homeowner asked'], ['OTHER', 'Other']] as const;

/** What the homeowner sees: schedule changes to explain (RES-52), the weekly update (RES-90), the closeout package (RES-97). */
export function ClientSide({ jobId, today }: { jobId: string; today: string }) {
  const { readOnly } = useShell();
  const url = `/api/residential/jobs/${jobId}/client`;
  const b = useBoard<Data>(url);
  const { run, busy, error } = useDo(b.reload);
  const [reason, setReason] = useState<Record<string, string>>({});
  const draft = b.data?.updates.find((u) => u.status === 'DRAFT') ?? null;
  const [text, setText] = useState('');
  useEffect(() => { setText(draft?.body ?? ''); }, [draft?.id, draft?.body]);
  const state = <BoardState b={b} what="Client side" />;
  if (!b.data) return state;
  const d = b.data;
  const pending = d.changes.filter((c) => c.status === 'PENDING');
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      <Section title="Homeowner schedule" meta={`${count(d.clientVisibleTasks)} items visible to the homeowner`}
        actions={readOnly ? null : <Button disabled={busy === 'flt'} onClick={() => run('flt', url, { op: 'schedule_filter' }, (r: { visible: number }) => `${r.visible} items now visible`)}>Pick what the homeowner sees</Button>}>
        {pending.length === 0 ? <Empty title="No date changes to explain" body="When a date the homeowner can see moves a day or more, it lands here to explain in a sentence." /> :
          <ul className="ops-agenda">{pending.map((c) => <li key={c.id}><span className="d">{c.shift_days > 0 ? `+${c.shift_days}` : c.shift_days} d</span>
            <span>{c.task_title}: {day(c.old_finish ?? c.old_start, today)} → {day(c.new_finish ?? c.new_start, today)}{!readOnly && <> <Select aria-label="Reason" value={reason[c.id] ?? ''} onChange={(e) => setReason({ ...reason, [c.id]: e.target.value })}>
              <option value="">Why?</option>{REASONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
              <Button disabled={!reason[c.id] || busy === c.id} onClick={() => run(c.id, url, { op: 'post_change', changeId: c.id, reason: reason[c.id] }, 'Posted to the homeowner')}>Tell the homeowner</Button>
              <Button variant="quiet" onClick={() => run(`x${c.id}`, url, { op: 'dismiss_change', changeId: c.id }, 'Dismissed')}>Dismiss</Button></>}</span></li>)}</ul>}
      </Section>
      <Section title="Weekly update" meta="Drafted from this week's logs, photos, schedule and change orders"
        actions={readOnly ? null : <Button disabled={busy === 'drf'} onClick={() => run('drf', url, { op: 'draft_update' }, 'Drafted this week')}>{draft ? 'Redraft' : 'Draft this week'}</Button>}>
        {!draft ? <Empty title="No draft this week" body="Draft it now or let Friday's sweep do it; you edit and send." /> : (
          <div className="stack">
            <Field label={`Week of ${draft.week_of}${draft.edited ? ' · edited' : ''}`}><Textarea rows={10} value={text} disabled={readOnly} onChange={(e) => setText(e.target.value)} /></Field>
            <p className="l2">{count(draft.photo_document_ids.length)} photo(s) attached from this week.</p>
            {!readOnly && <span className="btn-row"><Button disabled={busy === 'sav' || !text.trim()} onClick={() => run('sav', url, { op: 'edit_update', updateId: draft.id, body: text }, 'Saved')}>Save</Button>
              <Button variant="primary" disabled={busy === 'snd'} onClick={async () => { if (text !== draft.body) await run('sav', url, { op: 'edit_update', updateId: draft.id, body: text }, null); await run('snd', url, { op: 'send_update', updateId: draft.id }, 'Sent to the homeowner'); }}>Send to the homeowner</Button></span>}
          </div>)}
        {d.updates.filter((u) => u.status === 'SENT').slice(0, 4).map((u) => <p key={u.id} className="l2">Sent {day(u.sent_at, today)} · week of {u.week_of}</p>)}
      </Section>
      <Section title="Closeout package" meta={d.closeout ? (d.closeout.status === 'PUBLISHED' ? `Published ${day(d.closeout.published_at, today)}` : 'Draft') : 'Not started'}
        actions={readOnly ? null : <span className="btn-row"><Button disabled={busy === 'asm'} onClick={() => run('asm', url, { op: 'assemble_closeout' }, (r: { missing: string[] }) => (r.missing.length ? `Still missing: ${r.missing.join(', ')}` : 'Everything is in'))}>Assemble</Button>
          {d.closeout && d.closeout.status === 'DRAFT' && <Button variant="primary" disabled={busy === 'pub'} onClick={() => run('pub', url, { op: 'publish_closeout', packageId: d.closeout!.id }, 'Published to the portal')}>Publish to the portal</Button>}</span>}>
        {!d.closeout || d.closeout.items.length === 0 ? <Empty title="Nothing assembled yet" body="Assemble pulls warranties, manuals, the product list and paint colors from approved selections, rough-in photos and final lien releases." /> :
          <table className="ops-mini" aria-label="Closeout items"><thead><tr><th>Kind</th><th>Item</th><th>In package</th></tr></thead>
            <tbody>{d.closeout.items.map((i) => <tr key={i.id}><td>{i.kind.toLowerCase().replace(/_/g, ' ')}</td><td>{i.title}</td>
              <td>{readOnly || d.closeout!.status !== 'DRAFT' ? (i.included ? 'Yes' : 'No') : <Button onClick={() => run(`i${i.id}`, url, { op: 'include_item', itemId: i.id, included: !i.included }, null)}>{i.included ? <Status kind="ready" pip="ready">Included</Status> : 'Left out'}</Button>}</td></tr>)}</tbody></table>}
      </Section>
    </div>
  );
}
