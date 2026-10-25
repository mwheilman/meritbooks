'use client';

import { useState } from 'react';
import { Button, ButtonRow, Field, Input, QueueTable, Select, Status, count, type QueueColumn } from '@meritbooks/merit-ui';
import type { JobOption } from '@/lib/pm/ops/scope';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, JobSelect, Section } from '@/components/ops/common/bits';
import { BoardState, Empty, day, qty, useBoard, useDo } from '@/components/dealer/common/depth';

interface Demand { key: string; item_id: string | null; description: string; uom: string | null; kind: string; required_qty: number; issued_qty: number; on_hand_qty: number; on_order_qty: number; short_qty: number; suggested_qty: number; need_by: string | null; lead_days: number; order_by: string | null; long_lead: boolean; vendor_id: string | null; orders: string[] | null }
interface Data { rows: Demand[]; vendors: Array<{ id: string; name: string }>; purchaseOrders: Array<{ id: string; number: string | null; title: string | null; vendor_id: string; job_id: string; status: string }>; poLines: Array<{ id: string; commitment_id: string; line_no: number; description: string; qty: number | null; uom: string | null; received_qty: number | null }> }

/** What released and planned orders need vs on hand and on order; short lines become a draft PO; PO lines are received into stock. */
export function MaterialsView({ companyId, today, jobs }: { companyId: string; today: string; jobs: JobOption[] }) {
  const { readOnly } = useShell();
  const b = useBoard<Data>(`/api/mfg/materials?company=${companyId}`);
  const { run, busy, error } = useDo(b.reload);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [vendor, setVendor] = useState('');
  const [job, setJob] = useState('');
  const [recv, setRecv] = useState<Record<string, string>>({});
  const state = <BoardState b={b} what="Material demand" />;
  if (!b.data) return state;
  const d = b.data;
  const short = d.rows.filter((r) => r.short_qty > 0);
  const vname = (id: string | null) => d.vendors.find((v) => v.id === id)?.name ?? '—';
  const cols: QueueColumn<Demand>[] = [
    { id: 'm', header: 'Material', cell: (r) => <><span className="l1">{r.description}</span><span className="l2">{r.kind.toLowerCase()} · {(r.orders ?? []).join(', ')}</span></> },
    { id: 'r', header: 'Needed', numeric: true, width: 90, cell: (r) => qty(r.required_qty, r.uom) },
    { id: 'h', header: 'On hand', numeric: true, width: 90, cell: (r) => qty(r.on_hand_qty) },
    { id: 'o', header: 'On order', numeric: true, width: 90, cell: (r) => qty(r.on_order_qty) },
    { id: 's', header: 'Short', numeric: true, width: 90, cell: (r) => (r.short_qty > 0 ? <b className="neg">{qty(r.short_qty)}</b> : '—') },
    { id: 'b', header: 'Order by', width: 150, cell: (r) => (r.order_by ? <Status kind={r.long_lead ? 'overdue' : 'track'} pip={r.long_lead ? 'overdue' : 'open'}>{day(r.order_by, today)}{r.long_lead ? ' · long lead' : ''}</Status> : '—') },
    { id: 'v', header: 'Vendor', width: 160, cell: (r) => <span className="l2">{vname(r.vendor_id)}</span> },
  ];
  const chosen = short.filter((r) => sel.has(r.key));
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      <Section title="Material demand" meta={`${count(short.length)} short · ${count(short.filter((r) => r.long_lead).length)} long lead`}>
        {d.rows.length === 0 ? <Empty title="Nothing on order books" body="Material demand comes from the BOMs of released and planned production orders." /> :
          <div className="mp-table"><QueueTable aria-label="Material demand" columns={cols} rows={d.rows} getRowId={(r) => r.key} selectable={!readOnly} selected={sel} onSelectedChange={setSel} rowState={(r) => ({ attn: r.long_lead && r.short_qty > 0 })} /></div>}
        {!readOnly && chosen.length > 0 && (
          <div className="ops-toolbar" style={{ marginTop: 8 }}>
            <span className="t-cap">{count(chosen.length)} lines</span>
            <Field label="Job"><JobSelect jobs={jobs} value={job} onChange={setJob} /></Field>
            <Field label="Vendor"><Select value={vendor} onChange={(e) => setVendor(e.target.value)}><option value="">Pick a vendor</option>{d.vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</Select></Field>
            <Button variant="primary" disabled={!vendor || !job || busy === 'po'} onClick={async () => {
              const lines = chosen.map((r) => ({ item_id: r.item_id, description: r.description, qty: r.suggested_qty || r.short_qty, uom: r.uom, unit_cost_cents: 0 }));
              if (await run('po', '/api/mfg/materials', { op: 'create_po', jobId: job, vendorId: vendor, lines, title: 'Shop material' }, 'Drafted the purchase order; it goes through Approvals')) setSel(new Set());
            }}>Draft purchase order</Button>
          </div>
        )}
      </Section>
      <Section title="Receive" meta={`${count(d.poLines.length)} open PO lines`}>
        {d.poLines.length === 0 ? <p className="t-cap">No open purchase-order lines on this company’s jobs.</p> : (
          <table className="ops-mini" aria-label="Open PO lines">
            <thead><tr><th>PO</th><th>Line</th><th className="n">Ordered</th><th className="n">Received</th><th className="n">Receive now</th><th /></tr></thead>
            <tbody>{d.poLines.map((l) => {
              const po = d.purchaseOrders.find((p) => p.id === l.commitment_id);
              return (
                <tr key={l.id}>
                  <td>{po?.number ?? 'PO'}<div className="t-cap">{vname(po?.vendor_id ?? null)}</div></td><td>{l.description}</td>
                  <td className="n">{qty(l.qty, l.uom)}</td><td className="n">{qty(l.received_qty ?? 0)}</td>
                  <td className="n"><Input aria-label={`Receive ${l.description}`} inputMode="decimal" value={recv[l.id] ?? ''} onChange={(e) => setRecv({ ...recv, [l.id]: e.target.value })} style={{ width: 80 }} /></td>
                  <td>{!readOnly && <ButtonRow><Button disabled={!(Number(recv[l.id]) > 0) || busy === l.id} onClick={async () => { if (await run(l.id, '/api/mfg/materials', { op: 'receive', lineId: l.id, qty: Number(recv[l.id]) }, 'Received into stock')) setRecv({ ...recv, [l.id]: '' }); }}>Receive</Button></ButtonRow>}</td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
      </Section>
    </div>
  );
}
