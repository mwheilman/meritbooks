'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button, ButtonRow, Field, Input, QueueTable, Select, Status, Textarea, count, money, type QueueColumn } from '@meritbooks/merit-ui';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, Section } from '@/components/ops/common/bits';
import { BoardState, Empty, centsFrom, day, pctText, qty, useBoard, useDo } from '@/components/dealer/common/depth';

interface Remake { id: string; job_id: string; work_order_id: string; part_label: string | null; reason_code: string; source: string; qty: number; notes: string | null; status: string; remake_work_order_id: string | null; est_material_cents: number | null; decided_at: string | null; decision_note: string | null; created_at: string }
interface Coq { from: string; to: string; by_reason: Array<{ reason_code: string; remakes: number; qty: number; remake_minutes: number; material_cents: number | null }>; shop_minutes: number; remake_minutes: number; remake_share: number | null; amounts_visible: boolean }

export const REMAKE_WORDS: Record<string, string> = { MACHINING: 'Machining', MATERIAL_DEFECT: 'Material defect', ASSEMBLY: 'Assembly', FINISH: 'Finish', DAMAGE_SHOP: 'Damaged in shop', DAMAGE_FIELD: 'Damaged on site', MEASURE: 'Wrong measure', DESIGN: 'Design', MISSING: 'Missing part', OTHER: 'Other' };

/** Remakes asked for at the station or on site, decided by someone else, and what they cost by reason. */
export function RemakesView({ companyId, today, orders }: { companyId: string; today: string; orders: Array<{ id: string; number: string; summary: string }> }) {
  const { readOnly } = useShell();
  const [range, setRange] = useState({ from: `${today.slice(0, 7)}-01`, to: today });
  const b = useBoard<{ remakes: Remake[]; coq: Coq }>(`/api/mfg/remakes?company=${companyId}&from=${range.from}&to=${range.to}`);
  const { run, busy, error } = useDo(b.reload);
  const [form, setForm] = useState({ wo: '', label: '', reason: 'MACHINING', qty: '1', notes: '' });
  const [decide, setDecide] = useState<Record<string, { note: string; material: string }>>({});
  const woNo = (id: string | null) => orders.find((o) => o.id === id)?.number ?? 'Order';

  const cols: QueueColumn<Remake>[] = [
    { id: 'p', header: 'Part', cell: (r) => <><span className="l1">{r.part_label ?? 'Part'} × {qty(r.qty)}</span><span className="l2">{REMAKE_WORDS[r.reason_code] ?? r.reason_code} · {r.source.toLowerCase()} · {day(r.created_at, today)}</span></> },
    { id: 'w', header: 'Order', width: 160, cell: (r) => <><Link className="l1 nlink" href={`/production?wo=${r.work_order_id}`}>{woNo(r.work_order_id)}</Link>{r.remake_work_order_id && <Link className="l2 nlink" href={`/production?wo=${r.remake_work_order_id}`}>Remake order</Link>}</> },
    { id: 's', header: 'Status', width: 120, cell: (r) => <Status kind={r.status === 'REQUESTED' ? 'track' : r.status === 'APPROVED' ? 'ready' : 'blocked'} pip="open">{r.status.toLowerCase()}</Status> },
    { id: 'm', header: 'Material', numeric: true, width: 110, cell: (r) => (r.est_material_cents == null ? '—' : money(r.est_material_cents)) },
    ...(readOnly ? [] : [{ id: 'd', header: <span className="sr">Decide</span>, width: 360, cell: (r: Remake) => (r.status !== 'REQUESTED' ? <span className="l2">{r.decision_note ?? ''}</span> : (
      <ButtonRow>
        <Input aria-label="Material estimate" inputMode="decimal" placeholder="Material $" value={decide[r.id]?.material ?? ''} onChange={(e) => setDecide({ ...decide, [r.id]: { note: decide[r.id]?.note ?? '', material: e.target.value } })} style={{ width: 100 }} />
        <Button disabled={busy === r.id} onClick={() => void run(r.id, '/api/mfg/remakes', { op: 'decide', remakeId: r.id, approve: true, estMaterialCents: centsFrom(decide[r.id]?.material ?? '') }, 'Approved; a remake order is open')}>Approve</Button>
        <Button variant="quiet" disabled={busy === r.id} onClick={() => void run(r.id, '/api/mfg/remakes', { op: 'decide', remakeId: r.id, approve: false, note: 'Not remade' }, 'Declined the remake')}>Decline</Button>
      </ButtonRow>
    )) } satisfies QueueColumn<Remake>]),
  ];

  return (
    <div className="stack">
      {error && <Failure text={error} />}
      <div className="ops-toolbar">
        <Field label="From"><Input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
        <Field label="To"><Input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
      </div>
      <BoardState b={b} what="Remakes" />
      {b.data && (
        <>
          <Section title="Cost of quality" meta={`${pctText(b.data.coq.remake_share)} of shop time went to remakes`}>
            {b.data.coq.by_reason.length === 0 ? <p className="t-cap">No remakes in this period.</p> : (
              <table className="ops-mini" aria-label="Cost of quality by reason">
                <thead><tr><th>Reason</th><th className="n">Remakes</th><th className="n">Parts</th><th className="n">Shop hours</th>{b.data.coq.amounts_visible && <th className="n">Material</th>}</tr></thead>
                <tbody>{b.data.coq.by_reason.map((r) => <tr key={r.reason_code}><td>{REMAKE_WORDS[r.reason_code] ?? r.reason_code}</td><td className="n">{count(r.remakes)}</td><td className="n">{qty(r.qty)}</td><td className="n">{qty(Math.round(Number(r.remake_minutes) / 6) / 10)}</td>{b.data!.coq.amounts_visible && <td className="n">{r.material_cents == null ? '—' : money(r.material_cents)}</td>}</tr>)}</tbody>
              </table>
            )}
          </Section>
          <Section title="Remakes" meta={`${count(b.data.remakes.filter((r) => r.status === 'REQUESTED').length)} to decide`}>
            {b.data.remakes.length === 0 ? <Empty title="No remakes" body="Workers ask for a remake from the station; the office decides here, and an approved remake opens its own order." /> :
              <div className="mp-table"><QueueTable aria-label="Remakes" columns={cols} rows={b.data.remakes} getRowId={(r) => r.id} rowState={(r) => ({ attn: r.status === 'REQUESTED' })} /></div>}
          </Section>
        </>
      )}
      {!readOnly && (
        <Section title="Ask for a remake" meta="From the office or QC">
          <div className="ops-toolbar">
            <Field label="Order"><Select value={form.wo} onChange={(e) => setForm({ ...form, wo: e.target.value })}><option value="">Pick an order</option>{orders.map((o) => <option key={o.id} value={o.id}>{o.number} · {o.summary}</option>)}</Select></Field>
            <Field label="Part label"><Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} style={{ width: 140 }} /></Field>
            <Field label="Why"><Select value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })}>{Object.entries(REMAKE_WORDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
            <Field label="Qty"><Input inputMode="decimal" value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} style={{ width: 70 }} /></Field>
          </div>
          <Field label="Notes"><Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
          <Button variant="primary" disabled={!form.wo || !form.label.trim() || busy === 'req'} onClick={async () => {
            if (await run('req', '/api/mfg/remakes', { op: 'request', workOrderId: form.wo, partLabel: form.label.trim(), reason: form.reason, qty: Number(form.qty) > 0 ? Number(form.qty) : 1, notes: form.notes || null, source: 'QC' }, 'Asked for the remake')) setForm({ ...form, label: '', notes: '' });
          }}>Ask for the remake</Button>
        </Section>
      )}
    </div>
  );
}
