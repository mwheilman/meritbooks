'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Bands, Button, Field, QueueTable, Select, WidgetState, count, shortDate, type QueueColumn } from '@meritbooks/merit-ui';
import { SPECIAL_ORDER_NEXT, SPECIAL_ORDER_STATUS, SPECIAL_ORDER_VERB } from '@/lib/pm/dealer/labels';
import type { SpecialOrderList } from '@/lib/pm/dealer/parts-queries';
import type { SpecialOrderRow, SpecialOrderStatus, StockLocationRow } from '@/lib/pm/dealer/types';
import type { LookupItem } from '@/lib/pm/ops/types';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, StatusMark } from '@/components/ops/common/bits';
import { Lookup } from '@/components/ops/common/Lookup';
import { useStore } from '../common/useStore';

type Band = Exclude<SpecialOrderStatus, 'CANCELLED'>;
const BANDS: ReadonlyArray<{ value: Band; label: string; caption: string }> = [
  { value: 'REQUESTED', label: 'Requested', caption: 'Not on an order yet' },
  { value: 'ORDERED', label: 'Ordered', caption: 'With the vendor' },
  { value: 'RECEIVED', label: 'In', caption: 'Arrived; tell the customer' },
  { value: 'NOTIFIED', label: 'Notified', caption: 'Waiting on pickup' },
  { value: 'PICKED_UP', label: 'Picked up', caption: 'Last 30 days' },
];

export interface SpecialOrdersViewProps {
  data: SpecialOrderList;
  stockLocations: StockLocationRow[];
  defaultStockLocationId: string | null;
  today: string;
}

/** Special orders from the counter, repair orders and deals, by where they are; order the requested ones in a batch. */
export function SpecialOrdersView(p: SpecialOrdersViewProps) {
  const { readOnly } = useShell();
  const { act, busy, error } = useStore();
  const d = p.data;
  const first = BANDS.find((b) => d.orders.some((o) => o.status === b.value))?.value ?? 'REQUESTED';
  const [band, setBand] = useState<Band>(first === 'PICKED_UP' ? 'REQUESTED' : first);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [vendor, setVendor] = useState<LookupItem | null>(null);
  const [sl, setSl] = useState(p.defaultStockLocationId ?? p.stockLocations[0]?.id ?? '');
  const inBand = (b: Band) => d.orders.filter((o) => o.status === b);
  const rows = inBand(band);
  const companyOf = useMemo(() => new Map(d.orders.map((o) => [o.id, o.location_id])), [d.orders]);

  const forWho = (o: SpecialOrderRow) => {
    if (o.work_order_id) return <Link className="nlink" href={`/work-orders?wo=${o.work_order_id}`}>{d.ros[o.work_order_id] ?? 'Repair order'}</Link>;
    if (o.deal_id) return <Link className="nlink" href={`/deals/${o.deal_id}`}>Deal {d.deals[o.deal_id] ?? ''}</Link>;
    return <span>{o.customer_id ? d.customers[o.customer_id] ?? 'Customer' : 'Customer'}</span>;
  };

  const advance = (o: SpecialOrderRow, to: SpecialOrderStatus) =>
    void act(`so:${o.id}`, 'post', `/api/dealer/special-orders/${o.id}`, { to, stockLocationId: to === 'RECEIVED' ? sl || null : null }, `${o.number}: ${SPECIAL_ORDER_STATUS[to].word.toLowerCase()}`);

  const columns: QueueColumn<SpecialOrderRow>[] = [
    { id: 'n', header: 'Order', width: 140, cell: (o) => <><span className="l1 code">{o.number}</span><span className="l2">{shortDate(o.created_at.slice(0, 10), p.today)}</span></> },
    { id: 'p', header: 'Part', cell: (o) => <><span className="l1 b">{d.parts[o.part_id]?.part_number ?? 'Part'}</span><span className="l2">{d.parts[o.part_id]?.description ?? ''}</span></> },
    { id: 'q', header: 'Qty', numeric: true, width: 64, cell: (o) => count(o.qty) },
    { id: 'f', header: 'For', width: 180, cell: (o) => <><span className="l1">{forWho(o)}</span><span className="l2">{o.work_order_id || o.deal_id ? (o.customer_id ? d.customers[o.customer_id] ?? '' : '') : 'Counter'}</span></> },
    { id: 'v', header: 'Vendor', width: 150, cell: (o) => <span className="l2">{o.vendor_id ? d.vendors[o.vendor_id] ?? 'Vendor' : '—'}</span> },
    { id: 'nb', header: 'Needed', width: 96, cell: (o) => (o.needed_by ? <span className={o.needed_by < p.today && ['REQUESTED', 'ORDERED'].includes(o.status) ? 'neg b' : undefined}>{shortDate(o.needed_by, p.today)}</span> : '—') },
    { id: 's', header: 'Status', width: 180, cell: (o) => <StatusMark mark={SPECIAL_ORDER_STATUS[o.status]} /> },
    ...(readOnly ? [] : [{
      id: 'a', header: <span className="sr">Next</span>, width: 220,
      cell: (o: SpecialOrderRow) => (
        <div className="btn-row">
          {SPECIAL_ORDER_NEXT[o.status].filter((x) => x !== 'CANCELLED').map((to) => <Button key={to} variant={to === SPECIAL_ORDER_NEXT[o.status][0] ? 'default' : 'quiet'} disabled={busy === `so:${o.id}`} onClick={() => advance(o, to)}>{SPECIAL_ORDER_VERB[to]}</Button>)}
          {SPECIAL_ORDER_NEXT[o.status].includes('CANCELLED') && <Button variant="quiet" disabled={busy === `so:${o.id}`} onClick={() => advance(o, 'CANCELLED')}>Cancel</Button>}
        </div>
      ),
    } satisfies QueueColumn<SpecialOrderRow>]),
  ];

  const orderSelected = async (list: SpecialOrderRow[]) => {
    if (!vendor || !list.length) return;
    const companyId = companyOf.get(list[0]!.id)!;
    if (list.some((o) => companyOf.get(o.id) !== companyId)) return;
    const r = await act<{ orderId: string; number: string | null }>('order', 'post', '/api/dealer/parts-orders', {
      companyId, vendorId: vendor.id, stockLocationId: sl || null, kind: 'SPECIAL',
      lines: list.map((o) => ({ partId: o.part_id, qty: o.qty, specialOrderId: o.id })),
    }, (x) => `Started ${x.number ?? 'the order'} with ${list.length} special order${list.length === 1 ? '' : 's'}; submit it from Stock orders`);
    if (r.data) setSelected(new Set());
  };

  return (
    <div className="stack">
      <div className="ops-toolbar">
        {p.stockLocations.length > 1 && (
          <Field label="Receive into"><Select value={sl} onChange={(e) => setSl(e.target.value)}>{p.stockLocations.map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}</Select></Field>
        )}
        <span className="sp" />
        <span className="t-cap">Special orders are requested from the counter (short lines), a repair order or a deal, or from the catalog.</span>
      </div>
      {error && <Failure text={error} />}
      <Bands<Band> aria-label="Special orders by status" value={band} onChange={(b) => { setBand(b); setSelected(new Set()); }} items={BANDS.map((b) => ({ value: b.value, label: b.label, count: count(inBand(b.value).length), caption: b.caption }))} />
      <div className="mp-table">
        {rows.length === 0 ? (
          <WidgetState state={d.orders.length === 0
            ? { kind: 'empty', title: 'No special orders', body: 'When the counter is short, a repair order needs a part, or a deal needs an attachment, request it and it shows here until the customer picks it up.' }
            : { kind: 'done', title: `Nothing ${BANDS.find((b) => b.value === band)?.label.toLowerCase()}`, body: band === 'RECEIVED' ? 'Every part that came in has been called in.' : 'Pick another band above.' }} />
        ) : (
          <QueueTable aria-label="Special orders" columns={columns} rows={rows} getRowId={(o) => o.id}
            selectable={band === 'REQUESTED' && !readOnly} selected={selected} onSelectedChange={setSelected}
            rowState={(o) => ({ attn: o.status === 'RECEIVED' || (!!o.needed_by && o.needed_by < p.today && ['REQUESTED', 'ORDERED'].includes(o.status)) })}
            bulkSummary={(rs) => [`${rs.length} selected`, `${count(rs.reduce((s, o) => s + o.qty, 0))} pieces`]}
            bulkActions={(rs) => (
              <div className="row" style={{ gap: 8 }}>
                <div style={{ width: 220 }}><Lookup kind="vendors" value={vendor ? { id: vendor.id, label: vendor.label } : null} onChange={setVendor} placeholder="Order from vendor" aria-label="Vendor" /></div>
                <Button variant="primary" disabled={!vendor || busy === 'order'} onClick={() => void orderSelected(rs)}>Order these</Button>
              </div>
            )} />
        )}
      </div>
    </div>
  );
}
