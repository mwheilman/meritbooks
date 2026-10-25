'use client';

import { useState } from 'react';
import { AppLink, Bands, Button, Field, InlineNotice, Input, Select, Status, money, type StatusKind } from '@meritbooks/merit-ui';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, Section, parseNum } from '@/components/ops/common/bits';
import { BoardState, Empty, centsFrom, day, qty, useBoard, useDo } from '@/components/dealer/common/depth';

type Bucket = 'OVERDUE' | 'THIS_WEEK' | 'LATER' | 'RECEIVED_NOT_STAGED';
interface Item { id: string; job_id: string; job_number: string; job: string; description: string; sku: string | null; vendor: string | null; po_number: string | null; status: string;
  ordered_on: string | null; expected_on: string | null; received_on: string | null; received_condition: string | null; sidemark: string | null; bucket: Bucket }
interface Unmatched { id: string; vendor: string | null; description: string; po_number: string | null; qty: number | null; received_on: string }
interface Lot { id: string; product_id: string; lot_code: string; pallet: string | null; cartons_on_hand: number; cartons_reserved: number; reserved_job_id: string | null; received_on: string; last_counted_on: string | null }
interface Product { id: string; sku: string | null; style: string; color: string | null; price_retail_cents: number | null; sell_uom: string }

const BUCKETS: Array<{ value: Bucket; label: string }> = [{ value: 'OVERDUE', label: 'Late' }, { value: 'THIS_WEEK', label: 'Due this week' }, { value: 'LATER', label: 'Later' }, { value: 'RECEIVED_NOT_STAGED', label: 'Received, not staged' }];
const KIND: Record<Bucket, StatusKind> = { OVERDUE: 'overdue', THIS_WEEK: 'risk', LATER: 'track', RECEIVED_NOT_STAGED: 'ready' };

/** Special orders (FLR-23), receiving without a match (FLR-28), shade / dye lots (FLR-26) and a counter sale (FLR-19) — the store's goods in one place. */
export function OrdersTracker({ companyId, today }: { companyId: string; today: string }) {
  const { readOnly } = useShell();
  const url = '/api/flooring/ops';
  const t = useBoard<{ items: Item[]; overdue: number; unmatched: Unmatched[] }>(`${url}?company=${companyId}&view=tracker`);
  const lots = useBoard<{ lots: Lot[] }>(`${url}?company=${companyId}&view=lots`);
  const cat = useBoard<{ products: Product[] }>(`/api/flooring/catalog?company=${companyId}`);
  const reload = () => { t.reload(); lots.reload(); };
  const { run, busy, error } = useDo(reload);
  const [bucket, setBucket] = useState<Bucket>('OVERDUE');
  const [match, setMatch] = useState<Record<string, string>>({});
  const [um, setUm] = useState({ description: '', vendor: '', po: '', qty: '' });
  const [lot, setLot] = useState({ productId: '', code: '', cartons: '', pallet: '' });
  const [sale, setSale] = useState<{ productId: string; qty: string; price: string; name: string; tax: string; pay: 'CARD' | 'CASH' | 'CHECK' | 'ON_ACCOUNT' }>({ productId: '', qty: '', price: '', name: '', tax: '', pay: 'CARD' });
  const products = cat.data?.products ?? [];
  const pname = (id: string) => { const p = products.find((x) => x.id === id); return p ? `${p.style}${p.color ? ` ${p.color}` : ''}` : 'Product'; };
  const items = t.data?.items ?? [];
  const counts = Object.fromEntries(BUCKETS.map((x) => [x.value, items.filter((i) => i.bucket === x.value).length])) as Record<Bucket, number>;
  const salePrice = sale.price ? centsFrom(sale.price) : null;
  const saleQty = parseNum(sale.qty);
  const taxRate = sale.tax ? parseNum(sale.tax) : 0;
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      <BoardState b={t} what="Special orders" />
      {t.data && <>
        {t.data.overdue > 0 && <InlineNotice tone="warn" title={`${t.data.overdue} special order(s) are late.`}>Call the vendor and tell the customer before the install date slips.</InlineNotice>}
        <Bands<Bucket> aria-label="Special orders by when they are due" value={bucket} onChange={setBucket} items={BUCKETS.map((x) => ({ ...x, count: counts[x.value] }))} />
        {items.filter((i) => i.bucket === bucket).length === 0 ? <Empty title="Nothing here" body="Every special order for a job — ordered, acknowledged, shipped, received — sorts into late, this week, later and received-not-staged." /> :
          <table className="ops-mini" aria-label="Special orders"><thead><tr><th>Job</th><th>Item</th><th>Vendor / PO</th><th>Expected</th><th>Status</th></tr></thead>
            <tbody>{items.filter((i) => i.bucket === bucket).map((i) => <tr key={i.id}><td><AppLink href={`/flooring/jobs/${i.job_id}`}>{i.job_number}</AppLink> <span className="l2">{i.job}</span></td>
              <td>{i.description}{i.sidemark && <span className="l2"> · {i.sidemark}</span>}</td><td>{i.vendor ?? '—'}{i.po_number && <span className="l2"> · PO {i.po_number}</span>}</td>
              <td>{day(i.expected_on, today)}</td><td><Status kind={KIND[i.bucket]} pip="open">{i.status.toLowerCase().replace(/_/g, ' ')}</Status>{i.received_condition && i.received_condition !== 'GOOD' && <span className="l2 neg"> {i.received_condition.toLowerCase()}</span>}</td></tr>)}</tbody></table>}

        <Section title="Received with no match" meta={`${t.data.unmatched.length} open`}>
          {t.data.unmatched.length === 0 ? <p className="l2">Everything on the dock is matched to an order.</p> :
            <table className="ops-mini" aria-label="Unmatched receipts"><tbody>{t.data.unmatched.map((u) => <tr key={u.id}><td>{u.description}</td><td>{u.vendor ?? '—'}{u.po_number ? ` · PO ${u.po_number}` : ''}</td><td>{qty(u.qty)}</td><td>{day(u.received_on, today)}</td>
              <td>{!readOnly && <span className="btn-row"><Select aria-label="Match to an order" value={match[u.id] ?? ''} onChange={(e) => setMatch({ ...match, [u.id]: e.target.value })}><option value="">Match to…</option>
                {items.filter((i) => i.bucket !== 'RECEIVED_NOT_STAGED').map((i) => <option key={i.id} value={i.id}>{i.job_number} · {i.description}{i.po_number ? ` · PO ${i.po_number}` : ''}</option>)}</Select>
                <Button disabled={!match[u.id] || busy === u.id} onClick={() => run(u.id, url, { op: 'match_receipt', companyId, unmatchedId: u.id, procurementItemId: match[u.id] }, 'Matched and received')}>Match</Button></span>}</td></tr>)}</tbody></table>}
          {!readOnly && <div className="ops-toolbar">
            <Field label="What came in"><Input value={um.description} onChange={(e) => setUm({ ...um, description: e.target.value })} /></Field>
            <Field label="From"><Input value={um.vendor} onChange={(e) => setUm({ ...um, vendor: e.target.value })} /></Field>
            <Field label="PO on the packing slip"><Input value={um.po} style={{ width: 110 }} onChange={(e) => setUm({ ...um, po: e.target.value })} /></Field>
            <Field label="Qty" error={um.qty && parseNum(um.qty) == null ? 'A number' : undefined}><Input value={um.qty} style={{ width: 70 }} onChange={(e) => setUm({ ...um, qty: e.target.value })} /></Field>
            <Button disabled={!um.description.trim() || busy === 'um'} onClick={async () => { const r = await run('um', url, { op: 'unmatched', companyId, description: um.description.trim(), vendorName: um.vendor || null, poNumber: um.po || null, qty: parseNum(um.qty) }, 'Logged on the dock'); if (r) setUm({ description: '', vendor: '', po: '', qty: '' }); }}>Log it</Button>
          </div>}
        </Section>
      </>}

      <Section title="Shade and dye lots" meta="Cartons by lot so a job gets one shade">
        <BoardState b={lots} what="Lots" />
        {lots.data && (lots.data.lots.length === 0 ? <p className="l2">No lots received yet.</p> :
          <table className="ops-mini" aria-label="Lots"><thead><tr><th>Product</th><th>Lot</th><th className="n">On hand</th><th className="n">Reserved</th><th>Received</th><th /></tr></thead>
            <tbody>{lots.data.lots.map((l) => <tr key={l.id}><td>{pname(l.product_id)}</td><td>{l.lot_code}{l.pallet && <span className="l2"> · pallet {l.pallet}</span>}</td><td className="n">{qty(l.cartons_on_hand)}</td><td className="n">{qty(l.cartons_reserved)}</td><td>{day(l.received_on, today)}</td>
              <td>{!readOnly && l.cartons_reserved > 0 && <Button variant="quiet" disabled={busy === `r${l.id}`} onClick={() => run(`r${l.id}`, url, { op: 'lot_move', companyId, lotId: l.id, kind: 'RELEASE', cartons: l.cartons_reserved }, 'Released')}>Release</Button>}</td></tr>)}</tbody></table>)}
        {!readOnly && <div className="ops-toolbar">
          <Field label="Product"><Select value={lot.productId} onChange={(e) => setLot({ ...lot, productId: e.target.value })}><option value="">Pick</option>{products.filter((p) => p.sell_uom === 'CARTON' || p.sell_uom === 'SF').map((p) => <option key={p.id} value={p.id}>{p.style}{p.color ? ` ${p.color}` : ''}</option>)}</Select></Field>
          <Field label="Lot / shade"><Input value={lot.code} style={{ width: 110 }} onChange={(e) => setLot({ ...lot, code: e.target.value })} /></Field>
          <Field label="Cartons" error={lot.cartons && !/^\d+$/.test(lot.cartons) ? 'Whole cartons' : undefined}><Input value={lot.cartons} style={{ width: 80 }} onChange={(e) => setLot({ ...lot, cartons: e.target.value })} /></Field>
          <Field label="Pallet"><Input value={lot.pallet} style={{ width: 90 }} onChange={(e) => setLot({ ...lot, pallet: e.target.value })} /></Field>
          <Button disabled={!lot.productId || !lot.code.trim() || !/^[1-9]\d*$/.test(lot.cartons) || busy === 'lot'} onClick={async () => { const r = await run('lot', url, { op: 'lot_receive', companyId, productId: lot.productId, lotCode: lot.code.trim(), cartons: Number(lot.cartons), pallet: lot.pallet || null }, 'Lot received'); if (r) setLot({ productId: '', code: '', cartons: '', pallet: '' }); }}>Receive lot</Button>
        </div>}
      </Section>

      {!readOnly && <Section title="Counter sale" meta="Cash and carry — no job; Books gets the sale">
        <div className="ops-toolbar">
          <Field label="Product"><Select value={sale.productId} onChange={(e) => { const p = products.find((x) => x.id === e.target.value); setSale({ ...sale, productId: e.target.value, price: p?.price_retail_cents != null ? (p.price_retail_cents / 100).toFixed(2) : sale.price }); }}>
            <option value="">Pick</option>{products.map((p) => <option key={p.id} value={p.id}>{p.style}{p.color ? ` ${p.color}` : ''} ({p.sell_uom})</option>)}</Select></Field>
          <Field label="Qty" error={sale.qty && (saleQty == null || saleQty <= 0) ? 'More than zero' : undefined}><Input value={sale.qty} style={{ width: 70 }} onChange={(e) => setSale({ ...sale, qty: e.target.value })} /></Field>
          <Field label="Unit price" error={sale.price && salePrice == null ? 'Dollars' : undefined}><Input value={sale.price} style={{ width: 90 }} onChange={(e) => setSale({ ...sale, price: e.target.value })} /></Field>
          <Field label="Tax rate" help="Decimal, like 0.07" error={sale.tax && (taxRate == null || taxRate > 0.5) ? 'Like 0.07' : undefined}><Input value={sale.tax} style={{ width: 70 }} onChange={(e) => setSale({ ...sale, tax: e.target.value })} /></Field>
          <Field label="Customer"><Input value={sale.name} onChange={(e) => setSale({ ...sale, name: e.target.value })} /></Field>
          <Field label="Paid by"><Select value={sale.pay} onChange={(e) => setSale({ ...sale, pay: e.target.value as typeof sale.pay })}>{(['CARD', 'CASH', 'CHECK', 'ON_ACCOUNT'] as const).map((m) => <option key={m} value={m}>{m.toLowerCase().replace('_', ' ')}</option>)}</Select></Field>
          <Button variant="primary" disabled={!sale.productId || saleQty == null || saleQty <= 0 || salePrice == null || taxRate == null || taxRate > 0.5 || busy === 'sale'} onClick={async () => {
            const r = await run<{ total_cents: number }>('sale', url, { op: 'counter_sale', companyId, taxRate: taxRate ?? 0, customerName: sale.name || null, paymentMethod: sale.pay,
              lines: [{ kind: 'PRODUCT', product_id: sale.productId, description: pname(sale.productId), qty: saleQty, uom: products.find((p) => p.id === sale.productId)?.sell_uom ?? null, unit_price_cents: salePrice, taxable: true }] },
              (x: { total_cents: number }) => `Sold — ${money(x.total_cents)}`);
            if (r) setSale({ productId: '', qty: '', price: '', name: '', tax: sale.tax, pay: 'CARD' });
          }}>Ring it up</Button>
        </div>
      </Section>}
    </div>
  );
}
