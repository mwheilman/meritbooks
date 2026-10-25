'use client';

import { useMemo, useState } from 'react';
import { Button, ButtonRow, Drawer, Field, InlineNotice, Input, QueueTable, Select, Status, Textarea, count, useDebounce, type QueueColumn } from '@meritbooks/merit-ui';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, Section } from '@/components/ops/common/bits';
import { BoardState, Empty, FilePick, day, qty, useBoard, useDo } from '@/components/dealer/common/depth';
import type { Provider } from '@/lib/dealer/parts-ordering';
import { stocking } from '@/lib/dealer/stocking';

interface Sl { id: string; code: string; name: string; location_id: string }
interface Suggestion { part_id: string; part_number: string; description: string; vendor_id: string | null; bin: string | null; on_hand: number; on_order: number; demand_12m: number; avg_monthly: number; sd_monthly: number; season_index: number; lost_12m: number; current_min: number | null; current_max: number | null; min_qty: number; max_qty: number; order_qty: number }
interface Suggestions { lead_days: number; review_days: number; service_z: number; coverage_months: number; rows: Suggestion[] }
interface Backorders { backorders: Array<{ id: string; order_id: string; order_number: string; vendor: string | null; part_number: string; description: string; qty: number; eta: string | null; late: boolean; special_orders: number }>; transmissions: Array<{ id: string; order_id: string; order_number: string; provider: string; channel: string; format: string; status: string; sent_at: string | null; ack_at: string | null; error: string | null; file_name: string | null }> }
interface SoRow { id: string; number: string; status: string; qty: number; part_number: string; description: string; customer: string | null; received_at: string | null; waiting_days: number | null; stale: boolean; last_text: { status: string; at: string; reason: string | null } | null }

const SERVICE = [{ z: 0.84, label: '80% in stock' }, { z: 1.28, label: '90% in stock' }, { z: 1.65, label: '95% in stock' }, { z: 2.33, label: '99% in stock' }];

/** Suggested stock levels → a stock order → the OEM / distributor file → its acknowledgment and backorders; special-order texts. */
export function OrderingView({ companyId, today, stockLocations, vendors, openOrders }: { companyId: string; today: string; stockLocations: Sl[]; vendors: Array<{ id: string; name: string }>; openOrders: Array<{ id: string; number: string; status: string; vendor_id: string | null }> }) {
  const { readOnly } = useShell();
  const [sl, setSl] = useState(stockLocations[0]?.id ?? '');
  const [opts, setOpts] = useState({ lead: '7', review: '14', z: '1.28', vendor: '' });
  const qs = `stockLocation=${sl}&leadDays=${Number(opts.lead) || 7}&reviewDays=${Number(opts.review) || 14}&serviceZ=${opts.z}${opts.vendor ? `&vendor=${opts.vendor}` : ''}`;
  const sug = useBoard<Suggestions>(sl ? `/api/dealer/parts-desk?view=suggestions&${qs}` : null);
  const bo = useBoard<Backorders>(`/api/dealer/parts-desk?view=backorders&company=${companyId}`);
  const so = useBoard<SoRow[]>(`/api/dealer/parts-desk?view=special_orders&company=${companyId}`);
  const prov = useBoard<{ providers: Provider[] }>('/api/dealer/parts-desk?view=providers');
  const { run, busy, error } = useDo(() => { sug.reload(); bo.reload(); so.reload(); });
  const [edits, setEdits] = useState<Record<string, { min: string; max: string; order: string }>>({});
  const [tx, setTx] = useState<{ orderId: string; provider: string; account: string }>({ orderId: '', provider: 'STENS', account: '' });
  const [file, setFile] = useState<{ name: string; payload: string; instructions: string } | null>(null);
  const [ackFor, setAckFor] = useState<string | null>(null);
  const rows = sug.data?.rows ?? [];
  const pick = (r: Suggestion) => edits[r.part_id] ?? { min: String(r.min_qty), max: String(r.max_qty), order: String(r.order_qty) };

  const cols: QueueColumn<Suggestion>[] = [
    { id: 'p', header: 'Part', cell: (r) => <><span className="l1">{r.part_number}</span><span className="l2">{r.description}{r.bin ? ` · bin ${r.bin}` : ''}</span></> },
    { id: 'd', header: '12-mo demand', numeric: true, width: 120, cell: (r) => <>{qty(r.demand_12m)}{Number(r.lost_12m) > 0 && <div className="t-cap">{qty(r.lost_12m)} lost sales</div>}</> },
    { id: 's', header: 'Season', numeric: true, width: 80, cell: (r) => `×${Number(r.season_index).toFixed(2)}` },
    { id: 'h', header: 'On hand / order', numeric: true, width: 120, cell: (r) => `${qty(r.on_hand)} / ${qty(r.on_order)}` },
    { id: 'mm', header: 'Min / max', width: 170, cell: (r) => readOnly ? `${qty(r.min_qty)} / ${qty(r.max_qty)}` : (
      <ButtonRow>
        <Input aria-label={`Min for ${r.part_number}`} inputMode="decimal" value={pick(r).min} onChange={(e) => setEdits({ ...edits, [r.part_id]: { ...pick(r), min: e.target.value } })} style={{ width: 60 }} />
        <Input aria-label={`Max for ${r.part_number}`} inputMode="decimal" value={pick(r).max} onChange={(e) => {
          const max = e.target.value;
          const o = stocking({ avgMonthly: Number(r.avg_monthly), sdMonthly: Number(r.sd_monthly), season: Number(r.season_index), leadDays: sug.data!.lead_days, reviewDays: sug.data!.review_days, z: Number(sug.data!.service_z), onHand: Number(r.on_hand), onOrder: Number(r.on_order) });
          setEdits({ ...edits, [r.part_id]: { ...pick(r), max, order: String(Math.max((Number(max) || o.max) - Number(r.on_hand) - Number(r.on_order), 0)) } });
        }} style={{ width: 60 }} />
      </ButtonRow>) },
    { id: 'o', header: 'Order', numeric: true, width: 90, cell: (r) => readOnly ? qty(r.order_qty) : <Input aria-label={`Order quantity for ${r.part_number}`} inputMode="decimal" value={pick(r).order} onChange={(e) => setEdits({ ...edits, [r.part_id]: { ...pick(r), order: e.target.value } })} style={{ width: 64 }} /> },
  ];
  const toOrder = rows.filter((r) => Number(pick(r).order) > 0);

  return (
    <div className="stack">
      {error && <Failure text={error} />}
      <Section title="Suggested stock levels" meta="From 12 months of counter and RO demand plus logged lost sales, this season last year, the vendor lead time and how often you order">
        <div className="ops-toolbar">
          <Field label="Stock location"><Select value={sl} onChange={(e) => setSl(e.target.value)}>{stockLocations.map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}</Select></Field>
          <Field label="Lead days"><Input inputMode="numeric" value={opts.lead} onChange={(e) => setOpts({ ...opts, lead: e.target.value })} style={{ width: 70 }} /></Field>
          <Field label="Order every (days)"><Input inputMode="numeric" value={opts.review} onChange={(e) => setOpts({ ...opts, review: e.target.value })} style={{ width: 70 }} /></Field>
          <Field label="Target"><Select value={opts.z} onChange={(e) => setOpts({ ...opts, z: e.target.value })}>{SERVICE.map((s) => <option key={s.z} value={String(s.z)}>{s.label}</option>)}</Select></Field>
          <Field label="Vendor"><Select value={opts.vendor} onChange={(e) => setOpts({ ...opts, vendor: e.target.value })}><option value="">All vendors</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</Select></Field>
        </div>
        <BoardState b={sug} what="Suggestions" />
        {sug.data && (rows.length === 0 ? <Empty title="No demand yet" body="Parts that sell at the counter or on ROs, or that customers asked for and you did not have, get a suggested min / max here." /> : (
          <>
            <div className="mp-table"><QueueTable aria-label="Stock suggestions" columns={cols} rows={rows} getRowId={(r) => r.part_id} rowState={(r) => ({ attn: Number(r.on_hand) < Number(r.min_qty) })} onOpen={() => undefined} /></div>
            {!readOnly && (
              <ButtonRow>
                <Button disabled={busy === 'stock'} onClick={() => void run('stock', '/api/dealer/parts-desk', { op: 'apply_stocking', stockLocationId: sl, rows: rows.map((r) => ({ part_id: r.part_id, min_qty: Number(pick(r).min) || 0, max_qty: Number(pick(r).max) || null, bin: r.bin })) }, (n: number) => `${n} stocking levels saved`)}>Save min / max</Button>
                <Field label="Order from"><Select value={opts.vendor} onChange={(e) => setOpts({ ...opts, vendor: e.target.value })}><option value="">Pick the vendor</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</Select></Field>
                <Button variant="primary" disabled={!opts.vendor || !toOrder.length || busy === 'order'} onClick={() => void run<{ order_id: string; lines: number }>('order', '/api/dealer/parts-desk', { op: 'stock_order', stockLocationId: sl, vendorId: opts.vendor, lines: toOrder.map((r) => ({ part_id: r.part_id, qty: Number(pick(r).order) })) }, (d) => `Draft order with ${d.lines} lines`).then((d) => { if (d) setTx({ ...tx, orderId: d.order_id }); })}>Create the stock order ({count(toOrder.length)})</Button>
              </ButtonRow>
            )}
          </>
        ))}
      </Section>
      {!readOnly && (
        <Section title="Send an order" meta="Builds the file each distributor or OEM documents (X12 850 or their CSV); API ordering that needs a dealer agreement uploads the same file in their portal">
          <div className="ops-toolbar">
            <Field label="Order"><Select value={tx.orderId} onChange={(e) => setTx({ ...tx, orderId: e.target.value })}><option value="">Pick a draft or open order</option>{openOrders.map((o) => <option key={o.id} value={o.id}>{o.number} · {o.status.toLowerCase()}</option>)}</Select></Field>
            <Field label="Send to"><Select value={tx.provider} onChange={(e) => setTx({ ...tx, provider: e.target.value })}>{(prov.data?.providers ?? []).map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</Select></Field>
            <Field label="Dealer account"><Input value={tx.account} onChange={(e) => setTx({ ...tx, account: e.target.value })} style={{ width: 130 }} /></Field>
          </div>
          {prov.data && <p className="t-cap">{prov.data.providers.find((p) => p.code === tx.provider)?.notes}</p>}
          <ButtonRow>
            <Button variant="primary" disabled={!tx.orderId || !tx.account.trim() || busy === 'tx'} onClick={() => void run<{ fileName: string; payload: string; instructions: string }>('tx', '/api/dealer/parts-desk', { op: 'transmit', orderId: tx.orderId, provider: tx.provider, dealerAccount: tx.account.trim(), sent: true }, 'Recorded as sent').then((d) => { if (d) setFile({ name: d.fileName, payload: d.payload, instructions: d.instructions }); })}>Build the file and mark sent</Button>
          </ButtonRow>
          {file && (
            <InlineNotice tone="info" title={file.name}>
              {file.instructions}{' '}
              <a className="nlink" download={file.name} href={`data:text/plain;charset=utf-8,${encodeURIComponent(file.payload)}`}>Download the file</a>
            </InlineNotice>
          )}
        </Section>
      )}
      <Section title="Sent orders and backorders">
        <BoardState b={bo} what="Backorders" />
        {bo.data && (
          <>
            {bo.data.transmissions.length === 0 ? <Empty title="Nothing sent yet" body="Orders you send record what went out; load the acknowledgment (855 or CSV) to track backorders and ETAs." /> : (
              <table className="ops-mini" aria-label="Transmissions">
                <thead><tr><th>Order</th><th>To</th><th>Format</th><th>Status</th><th><span className="sr">Acknowledgment</span></th></tr></thead>
                <tbody>{bo.data.transmissions.map((t) => <tr key={t.id}><td>{t.order_number}<div className="t-cap">{day(t.sent_at, today)}</div></td><td>{t.provider}</td><td>{t.format.replace('_', ' ')}</td><td><Status kind={t.status === 'ACKNOWLEDGED' ? 'ready' : t.status === 'PARTIAL' ? 'risk' : t.status === 'REJECTED' || t.status === 'FAILED' ? 'blocked' : 'track'} pip="open">{t.status.toLowerCase()}</Status></td>
                  <td>{!readOnly && (t.status === 'SENT' || t.status === 'PARTIAL') && <FilePick label="Load the acknowledgment" accept=".edi,.x12,.txt,.855,.csv" disabled={busy === t.id} onText={(_n, text) => { setAckFor(t.id); void run<{ backorders: number }>(t.id, '/api/dealer/parts-desk', { op: 'ack', transmissionId: t.id, text }, (d) => `${d.backorders} backordered line(s)`).then(() => setAckFor(null)); }} />}{ackFor === t.id && <span className="t-cap"> Reading…</span>}</td></tr>)}</tbody>
              </table>
            )}
            {bo.data.backorders.length > 0 && (
              <table className="ops-mini" aria-label="Backorders">
                <thead><tr><th>Backordered</th><th>Order</th><th className="n">Qty</th><th>ETA</th></tr></thead>
                <tbody>{bo.data.backorders.map((x) => <tr key={x.id}><td>{x.part_number}<div className="t-cap">{x.description}{x.special_orders ? ` · ${x.special_orders} customer order(s) waiting` : ''}</div></td><td>{x.order_number} · {x.vendor ?? ''}</td><td className="n">{qty(x.qty)}</td><td>{x.eta ? <Status kind={x.late ? 'overdue' : 'track'} pip="open">{day(x.eta, today)}</Status> : '—'}</td></tr>)}</tbody>
              </table>
            )}
          </>
        )}
      </Section>
      <Section title="Customer special orders" meta="A received special order texts the customer; texts are held until the workspace goes live and honor STOP">
        <BoardState b={so} what="Special orders" />
        {so.data && (so.data.length === 0 ? <Empty title="No open special orders" body="Parts ordered for a customer show here until they are picked up." /> : (
          <table className="ops-mini" aria-label="Special orders">
            <thead><tr><th>Order</th><th>Customer</th><th>Status</th><th>Last text</th><th><span className="sr">Text</span></th></tr></thead>
            <tbody>{so.data.map((o) => <tr key={o.id}><td>{o.number}<div className="t-cap">{qty(o.qty)} × {o.part_number} {o.description}</div></td><td>{o.customer ?? '—'}</td><td><Status kind={o.stale ? 'overdue' : o.status === 'NOTIFIED' ? 'ready' : 'track'} pip="open">{o.status.toLowerCase()}{o.waiting_days != null ? ` · ${o.waiting_days}d` : ''}</Status></td><td>{o.last_text ? `${o.last_text.status} ${day(o.last_text.at, today)}` : '—'}{o.last_text?.reason && <div className="t-cap">{o.last_text.reason}</div>}</td>
              <td>{!readOnly && (o.status === 'RECEIVED' || o.status === 'NOTIFIED') && <Button variant="quiet" disabled={busy === o.id} onClick={() => void run(o.id, '/api/dealer/parts-desk', { op: 'text_special_order', soId: o.id }, 'Text queued')}>Text again</Button>}</td></tr>)}</tbody>
          </table>
        ))}
      </Section>
    </div>
  );
}

interface LocRow { location_id: string; store: string; part_id: string; part_number: string; manufacturer: string | null; description: string; stock_location_id: string; stock_location: string; bin: string | null; on_hand: number }
interface Xfer { id: string; number: string; status: string; qty: number; part_number: string; description: string; from_store: string; to_store: string; direction: string; requested_at: string; shipped_at: string | null; received_at: string | null; note: string | null }

/** Find a part at the other stores and move it: request → ship → receive. */
export function TransfersView({ companyId, today, myStockLocations }: { companyId: string; today: string; myStockLocations: Sl[] }) {
  const { readOnly } = useShell();
  const [pn, setPn] = useState('');
  const term = useDebounce(pn.trim(), 300);
  const loc = useBoard<LocRow[]>(term.length >= 2 ? `/api/dealer/parts-desk?view=locator&partNumber=${encodeURIComponent(term)}` : null);
  const xb = useBoard<Xfer[]>(`/api/dealer/parts-desk?view=transfers&company=${companyId}`);
  const { run, busy, error } = useDo(() => { loc.reload(); xb.reload(); });
  const [req, setReq] = useState<{ row: LocRow; qty: string; to: string; note: string } | null>(null);
  const others = useMemo(() => (loc.data ?? []).filter((r) => r.location_id !== companyId), [loc.data, companyId]);
  const cols: QueueColumn<Xfer>[] = [
    { id: 'n', header: 'Transfer', cell: (r) => <><span className="l1">{r.number} · {qty(r.qty)} × {r.part_number}</span><span className="l2">{r.from_store} → {r.to_store}{r.note ? ` · ${r.note}` : ''}</span></> },
    { id: 'd', header: 'Direction', width: 100, cell: (r) => r.direction.toLowerCase() },
    { id: 's', header: 'Status', width: 110, cell: (r) => <Status kind={r.status === 'RECEIVED' ? 'ready' : r.status === 'CANCELLED' ? 'blocked' : 'track'} pip="open">{r.status.toLowerCase()}</Status> },
    { id: 'w', header: 'Requested', width: 100, cell: (r) => day(r.requested_at, today) },
    ...(readOnly ? [] : [{ id: 'a', header: <span className="sr">Next</span>, width: 200, cell: (r: Xfer) => (
      <ButtonRow>
        {r.status === 'REQUESTED' && r.direction !== 'INBOUND' && <Button disabled={busy === r.id} onClick={() => void run(r.id, '/api/dealer/parts-desk', { op: 'advance_transfer', transferId: r.id, to: 'SHIPPED' }, 'Shipped')}>Ship</Button>}
        {r.status === 'SHIPPED' && r.direction !== 'OUTBOUND' && <Button variant="primary" disabled={busy === r.id} onClick={() => void run(r.id, '/api/dealer/parts-desk', { op: 'advance_transfer', transferId: r.id, to: 'RECEIVED' }, 'Received into stock')}>Receive</Button>}
        {r.status === 'REQUESTED' && <Button variant="quiet" disabled={busy === r.id} onClick={() => void run(r.id, '/api/dealer/parts-desk', { op: 'advance_transfer', transferId: r.id, to: 'CANCELLED' }, 'Cancelled')}>Cancel</Button>}
      </ButtonRow>) } satisfies QueueColumn<Xfer>]),
  ];
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      <Section title="Find a part at another store">
        <Field label="Part number"><Input value={pn} onChange={(e) => setPn(e.target.value)} placeholder="AM125172" style={{ width: 220 }} /></Field>
        {term.length >= 2 && <BoardState b={loc} what="Stores" />}
        {loc.data && (loc.data.length === 0 ? <Empty title="Not on hand anywhere" body="No store you can see has that part on hand. Order it, or check the supersession on the part." /> : (
          <table className="ops-mini" aria-label="On hand by store">
            <thead><tr><th>Store</th><th>Location / bin</th><th className="n">On hand</th><th><span className="sr">Request</span></th></tr></thead>
            <tbody>{loc.data.map((r) => <tr key={`${r.part_id}-${r.stock_location_id}`}><td>{r.store}<div className="t-cap">{r.part_number} {r.description}</div></td><td>{r.stock_location}{r.bin ? ` · ${r.bin}` : ''}</td><td className="n">{qty(r.on_hand)}</td>
              <td>{!readOnly && r.location_id !== companyId && <Button onClick={() => setReq({ row: r, qty: '1', to: myStockLocations[0]?.id ?? '', note: '' })}>Request</Button>}</td></tr>)}</tbody>
          </table>
        ))}
        {others.length === 0 && loc.data && loc.data.length > 0 && <p className="t-cap">Only this store has it on hand.</p>}
      </Section>
      <Section title="Transfers">
        <BoardState b={xb} what="Transfers" />
        {xb.data && (xb.data.length === 0 ? <Empty title="No transfers" body="Request a part from another store above; the sending store ships it and you receive it here." /> :
          <div className="mp-table"><QueueTable aria-label="Transfers" columns={cols} rows={xb.data} getRowId={(r) => r.id} onOpen={() => undefined} rowState={(r) => ({ attn: r.status === 'SHIPPED' && r.direction !== 'OUTBOUND', done: r.status === 'RECEIVED' })} /></div>)}
      </Section>
      {req && (
        <Drawer open onClose={() => setReq(null)} title={`Request ${req.row.part_number}`} meta={`From ${req.row.store} (${qty(req.row.on_hand)} on hand)`}>
          <div className="stack" style={{ padding: 16 }}>
            <Field label="Quantity"><Input inputMode="decimal" value={req.qty} onChange={(e) => setReq({ ...req, qty: e.target.value })} /></Field>
            <Field label="Receive into"><Select value={req.to} onChange={(e) => setReq({ ...req, to: e.target.value })}>{myStockLocations.map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}</Select></Field>
            <Field label="Note"><Textarea rows={2} value={req.note} onChange={(e) => setReq({ ...req, note: e.target.value })} /></Field>
            <Button variant="primary" disabled={!(Number(req.qty) > 0) || !req.to || busy === 'req'} onClick={() => void run('req', '/api/dealer/parts-desk', { op: 'request_transfer', partId: req.row.part_id, fromStockLocationId: req.row.stock_location_id, toStockLocationId: req.to, qty: Number(req.qty), note: req.note || null }, 'Transfer requested; the other store is notified').then((d) => { if (d) setReq(null); })}>Request the transfer</Button>
          </div>
        </Drawer>
      )}
    </div>
  );
}
