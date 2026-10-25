'use client';

import { useState } from 'react';
import { Bands, Button, Field, Input, QueueTable, Select, Status, count, money, type QueueColumn } from '@meritbooks/merit-ui';
import type { RollRow } from '@/app/api/flooring/rolls/route';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, Section } from '@/components/ops/common/bits';
import { BoardState, Empty, centsFrom, day, qty, useBoard, useDo } from '@/components/dealer/common/depth';

type Band = 'ALL' | 'AVAILABLE' | 'RESERVED' | 'REMNANT' | 'DAMAGED';
interface Data { rolls: RollRow[]; products: Array<{ id: string; sku: string; style: string; color: string | null; category: string; roll_width_ft: number | null }> }

const ftin = (inches: number) => `${Math.floor(inches / 12)}′ ${qty(Math.round((inches % 12) * 10) / 10)}″`;

/** Roll goods on hand by product and dye lot: full rolls, reserved rolls, remnants. Receiving here starts the lot trail. */
export function RollsView({ companyId, today }: { companyId: string; today: string }) {
  const { readOnly } = useShell();
  const [band, setBand] = useState<Band>('ALL');
  const b = useBoard<Data>(`/api/flooring/rolls?company=${companyId}&status=${band}`);
  const { run, busy, error } = useDo(b.reload);
  const [f, setF] = useState({ product: '', roll: '', lot: '', width: '144', lengthFt: '', bin: '', cost: '', condition: 'GOOD' });
  const prod = (id: string) => b.data?.products.find((p) => p.id === id);
  const cols: QueueColumn<RollRow>[] = [
    { id: 'p', header: 'Product', cell: (r) => { const p = prod(r.product_id); return <><span className="l1">{p ? `${p.style}${p.color ? ` ${p.color}` : ''}` : 'Product'}</span><span className="l2">Roll {r.roll_number} · lot {r.dye_lot}{r.parent_roll_id ? ' · remnant' : ''}</span></>; } },
    { id: 'w', header: 'Width', numeric: true, width: 90, cell: (r) => ftin(r.width_in) },
    { id: 'l', header: 'Left', numeric: true, width: 110, cell: (r) => <b>{ftin(r.remaining_len_in)}</b> },
    { id: 'b', header: 'Bin', width: 90, cell: (r) => r.bin ?? '—' },
    { id: 's', header: 'Status', width: 130, cell: (r) => <Status kind={r.status === 'AVAILABLE' ? 'ready' : r.status === 'REMNANT' ? 'track' : r.status === 'RESERVED' ? 'risk' : 'blocked'} pip="open">{r.status.toLowerCase()}</Status> },
    { id: 'c', header: 'Cost / LF', numeric: true, width: 100, cell: (r) => (r.cost_per_lf_cents == null ? '—' : money(r.cost_per_lf_cents)) },
    { id: 'r', header: 'Received', width: 110, cell: (r) => day(r.received_on, today) },
  ];
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      {!readOnly && (
        <Section title="Receive a roll" meta="Roll number and dye lot start the lot trail">
          <div className="ops-toolbar">
            <Field label="Product"><Select value={f.product} onChange={(e) => setF({ ...f, product: e.target.value, width: String(Math.round((prod(e.target.value)?.roll_width_ft ?? 12) * 12)) })}><option value="">Pick a product</option>{(b.data?.products ?? []).filter((p) => p.roll_width_ft).map((p) => <option key={p.id} value={p.id}>{p.style}{p.color ? ` ${p.color}` : ''}</option>)}</Select></Field>
            <Field label="Roll #"><Input value={f.roll} onChange={(e) => setF({ ...f, roll: e.target.value })} style={{ width: 110 }} /></Field>
            <Field label="Dye lot"><Input value={f.lot} onChange={(e) => setF({ ...f, lot: e.target.value })} style={{ width: 110 }} /></Field>
            <Field label="Width (in)"><Input inputMode="decimal" value={f.width} onChange={(e) => setF({ ...f, width: e.target.value })} style={{ width: 80 }} /></Field>
            <Field label="Length (ft)"><Input inputMode="decimal" value={f.lengthFt} onChange={(e) => setF({ ...f, lengthFt: e.target.value })} style={{ width: 90 }} /></Field>
            <Field label="Bin"><Input value={f.bin} onChange={(e) => setF({ ...f, bin: e.target.value })} style={{ width: 80 }} /></Field>
            <Field label="Cost / LF"><Input inputMode="decimal" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} style={{ width: 90 }} /></Field>
            <Field label="Condition"><Select value={f.condition} onChange={(e) => setF({ ...f, condition: e.target.value })}><option value="GOOD">Good</option><option value="DAMAGED">Damaged</option><option value="SHORT">Short</option></Select></Field>
            <Button variant="primary" disabled={!f.product || !f.roll.trim() || !f.lot.trim() || !(Number(f.lengthFt) > 0) || !(Number(f.width) > 0) || busy === 'rcv'} onClick={async () => {
              if (await run('rcv', '/api/flooring/rolls', { op: 'receive', companyId, productId: f.product, rollNumber: f.roll.trim(), dyeLot: f.lot.trim(), widthIn: Number(f.width), lengthIn: Math.round(Number(f.lengthFt) * 12 * 10) / 10, bin: f.bin || null, costPerLfCents: centsFrom(f.cost), condition: f.condition }, 'Received the roll')) setF({ ...f, roll: '', lengthFt: '', bin: '' });
            }}>Receive</Button>
          </div>
        </Section>
      )}
      <Bands<Band> aria-label="Rolls by status" value={band} onChange={setBand} items={[
        { value: 'ALL', label: 'On hand', count: band === 'ALL' && b.data ? count(b.data.rolls.length) : '' },
        { value: 'AVAILABLE', label: 'Full rolls', count: band === 'AVAILABLE' && b.data ? count(b.data.rolls.length) : '' },
        { value: 'RESERVED', label: 'Reserved', count: band === 'RESERVED' && b.data ? count(b.data.rolls.length) : '' },
        { value: 'REMNANT', label: 'Remnants', count: band === 'REMNANT' && b.data ? count(b.data.rolls.length) : '' },
        { value: 'DAMAGED', label: 'Damaged', count: band === 'DAMAGED' && b.data ? count(b.data.rolls.length) : '' },
      ]} />
      <BoardState b={b} what="Rolls" />
      {b.data && (b.data.rolls.length === 0 ? <Empty title="No rolls here" body="Receive roll goods with their roll number and dye lot; cuts come off them by job, and leftovers become remnants by the company's rule." /> :
        <div className="mp-table"><QueueTable aria-label="Rolls" columns={cols} rows={b.data.rolls} getRowId={(r) => r.id} rowState={(r) => ({ attn: r.status === 'DAMAGED' })} /></div>)}
    </div>
  );
}
