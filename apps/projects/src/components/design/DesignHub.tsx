'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bands, Button, ButtonLink, ButtonRow, Field, Input, QueueTable, Select, Status, count, type QueueColumn } from '@meritbooks/merit-ui';
import type { HubRow } from '@/app/api/design/hub/route';
import type { JobOption } from '@/lib/pm/ops/scope';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, Section } from '@/components/ops/common/bits';
import { BoardState, Empty, day, useBoard, useDo } from '@/components/dealer/common/depth';

type Bucket = HubRow['bucket'];
const BUCKETS: Array<{ value: Bucket; label: string; caption: string }> = [
  { value: 'OVERDUE', label: 'Overdue', caption: 'a date has passed' }, { value: 'TODAY', label: 'Today', caption: 'due today' },
  { value: 'THIS_WEEK', label: 'This week', caption: 'next 7 days' }, { value: 'LATER', label: 'Later', caption: 'scheduled' },
  { value: 'UNSCHEDULED', label: 'No dates', caption: 'needs dates' }, { value: 'DONE', label: 'Done', caption: 'every date done' },
];
export const DATE_KEYS = ['order', 'ship', 'delivery', 'install', 'client_deposit', 'vendor_deposit', 'client_balance', 'vendor_balance'] as const;
export const DATE_WORDS: Record<(typeof DATE_KEYS)[number], string> = { order: 'Order', ship: 'Ship', delivery: 'Delivery', install: 'Install', client_deposit: 'Client deposit', vendor_deposit: 'Vendor deposit', client_balance: 'Client balance', vendor_balance: 'Vendor balance' };

/** Every component across the studio's projects by what is due next: order, ship, deliver, install, and the four money dates. */
export function DesignHub({ companyId, today, jobs }: { companyId: string; today: string; jobs: JobOption[] }) {
  const { readOnly } = useShell();
  const router = useRouter();
  const b = useBoard<{ rows: HubRow[] }>(`/api/design/hub?company=${companyId}`);
  const { run, busy, error } = useDo(b.reload);
  const [bucket, setBucket] = useState<Bucket>('OVERDUE');
  const [edit, setEdit] = useState<{ id: string; key: (typeof DATE_KEYS)[number]; on: string } | null>(null);
  const jname = (id: string) => jobs.find((j) => j.id === id)?.label ?? 'Project';
  const rows = (b.data?.rows ?? []).filter((r) => r.bucket === bucket);
  const nextKey = (r: HubRow) => DATE_KEYS.find((k) => r.dates[k] && !r.dates[k]!.done && r.dates[k]!.on === r.next_due_on) ?? null;
  const cols: QueueColumn<HubRow>[] = [
    { id: 'i', header: 'Item', cell: (r) => <><span className="l1">{r.item_name}</span><span className="l2">{jname(r.job_id)} · {r.room}{r.sidemark ? ` · ${r.sidemark}` : ''}</span></> },
    { id: 'c', header: 'Component', width: 220, cell: (r) => <><span className="l1">{r.description}</span><span className="l2">{(r.component_kind ?? 'item').toLowerCase().replace(/_/g, ' ')}{r.po_number ? ` · ${r.po_number}` : ''}</span></> },
    { id: 's', header: 'Status', width: 120, cell: (r) => <Status kind={r.freight_claim_open ? 'blocked' : 'track'} pip="open">{r.freight_claim_open ? 'Freight claim' : r.status.toLowerCase()}</Status> },
    { id: 'n', header: 'Next', width: 190, cell: (r) => { const k = nextKey(r); return r.next_due_on ? <span className={r.bucket === 'OVERDUE' ? 'neg b' : undefined}>{k ? DATE_WORDS[k] : 'Due'} · {day(r.next_due_on, today)}</span> : '—'; } },
    ...(readOnly ? [] : [{ id: 'a', header: <span className="sr">Done</span>, width: 120, cell: (r: HubRow) => { const k = nextKey(r); return k ? <Button variant="quiet" disabled={busy === r.component_id} onClick={() => void run(r.component_id, '/api/design/hub', { op: 'set_date', componentId: r.component_id, key: k, on: r.dates[k]!.on, done: true }, `${DATE_WORDS[k]} done`)}>Mark done</Button> : null; } } satisfies QueueColumn<HubRow>]),
  ];
  return (
    <div className="stack">
      <ButtonRow><ButtonLink variant="quiet" href="/design/inbox">Vendor inbox</ButtonLink></ButtonRow>
      {error && <Failure text={error} />}
      <BoardState b={b} what="The procurement hub" />
      {b.data && (
        <>
          <Bands<Bucket> aria-label="Components by what is due" value={bucket} onChange={setBucket} items={BUCKETS.map((x) => ({ value: x.value, label: x.label, caption: x.caption, count: count(b.data!.rows.filter((r) => r.bucket === x.value).length) }))} />
          {rows.length === 0 ? <Empty title="Nothing here" body="Components show here by their next open date. Add items and components on a project; set the eight dates on each." /> :
            <div className="mp-table"><QueueTable aria-label="Components" columns={cols} rows={rows} getRowId={(r) => r.component_id} cursorId={edit?.id ?? null} openOnClick onOpen={(r) => router.push(`/design/${r.job_id}?item=${r.dsn_item_id}`)} rowState={(r) => ({ attn: r.bucket === 'OVERDUE' || !!r.freight_claim_open })} /></div>}
          {!readOnly && (
            <Section title="Move a date">
              <div className="ops-toolbar">
                <Field label="Component"><Select value={edit?.id ?? ''} onChange={(e) => setEdit({ id: e.target.value, key: edit?.key ?? 'ship', on: edit?.on ?? today })}><option value="">Pick a component</option>{(b.data?.rows ?? []).map((r) => <option key={r.component_id} value={r.component_id}>{r.item_name} · {r.description}</option>)}</Select></Field>
                <Field label="Date"><Select value={edit?.key ?? 'ship'} onChange={(e) => edit && setEdit({ ...edit, key: e.target.value as (typeof DATE_KEYS)[number] })}>{DATE_KEYS.map((k) => <option key={k} value={k}>{DATE_WORDS[k]}</option>)}</Select></Field>
                <Field label="On"><Input type="date" value={edit?.on ?? today} onChange={(e) => edit && setEdit({ ...edit, on: e.target.value })} /></Field>
                <Button variant="primary" disabled={!edit?.id || busy === 'date'} onClick={() => { if (edit?.id) void run('date', '/api/design/hub', { op: 'set_date', componentId: edit.id, key: edit.key, on: edit.on || null }, 'Moved the date'); }}>Save date</Button>
              </div>
            </Section>
          )}
        </>
      )}
    </div>
  );
}
