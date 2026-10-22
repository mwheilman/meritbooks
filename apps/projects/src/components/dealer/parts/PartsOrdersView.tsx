'use client';

import { useMemo, useState } from 'react';
import {
  Bands, Button, ConfirmDialog, Field, Input, Panel, PanelSection, QueueTable, Select, WidgetState, api, count, money, shortDate, type QueueColumn,
} from '@meritbooks/merit-ui';
import { PARTS_ORDER_STATUS } from '@/lib/pm/dealer/labels';
import type { CounterSearch, PartsOrderList } from '@/lib/pm/dealer/parts-queries';
import type { PartsOrderRow, PartsOrderStatus, StockLocationRow, SuggestedLine } from '@/lib/pm/dealer/types';
import type { LookupItem } from '@/lib/pm/ops/types';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, StatusMark, parseNum } from '@/components/ops/common/bits';
import { Lookup } from '@/components/ops/common/Lookup';
import { PickStoreNote } from '../common/StoreOff';
import { useStore } from '../common/useStore';

type Band = Exclude<PartsOrderStatus, 'CANCELLED'>;
const BANDS: ReadonlyArray<{ value: Band; label: string; caption: string }> = [
  { value: 'DRAFT', label: 'Draft', caption: 'Being built' },
  { value: 'SUBMITTED', label: 'Submitted', caption: 'With the vendor' },
  { value: 'PARTIAL', label: 'Partly received', caption: 'Back-ordered lines open' },
  { value: 'RECEIVED', label: 'Received', caption: 'Last 90 days' },
];

export interface PartsOrdersViewProps {
  data: PartsOrderList;
  stockLocations: StockLocationRow[];
  defaultStockLocationId: string | null;
  companyId: string | null;
  today: string;
}

/** OEM stock orders: build one from min/max suggestions, submit it, receive it into stock. */
export function PartsOrdersView(p: PartsOrdersViewProps) {
  const { readOnly } = useShell();
  const d = p.data;
  const first = BANDS.find((b) => d.orders.some((o) => o.status === b.value))?.value ?? 'DRAFT';
  const [band, setBand] = useState<Band>(first);
  const [cursor, setCursor] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const inBand = (b: Band) => d.orders.filter((o) => o.status === b);
  const rows = inBand(band);
  const cur = d.orders.find((o) => o.id === cursor) ?? null;
  const lineTotal = (orderId: string) => d.lines.filter((l) => l.order_id === orderId).reduce((s, l) => s + Math.round(l.qty_ordered * (l.unit_cost_cents ?? 0)), 0);

  const columns: QueueColumn<PartsOrderRow>[] = [
    { id: 'n', header: 'Order', width: 150, cell: (o) => <><span className="l1 code">{o.number}</span><span className="l2">{o.kind === 'STOCK' ? 'Stock order' : o.kind === 'EMERGENCY' ? 'Emergency' : 'Special orders'}</span></> },
    { id: 'v', header: 'Vendor', cell: (o) => <><span className="l1">{d.vendors[o.vendor_id] ?? 'Vendor'}</span><span className="l2">{o.vendor_ref ?? ' '}</span></> },
    { id: 'l', header: 'Lines', numeric: true, width: 70, cell: (o) => count(d.lines.filter((l) => l.order_id === o.id).length) },
    { id: 'c', header: 'At cost', numeric: true, width: 120, cell: (o) => money(lineTotal(o.id)) },
    { id: 'dt', header: 'Submitted', width: 110, cell: (o) => (o.submitted_at ? shortDate(o.submitted_at.slice(0, 10), p.today) : '—') },
    { id: 's', header: 'Status', width: 160, cell: (o) => <StatusMark mark={PARTS_ORDER_STATUS[o.status]} /> },
  ];

  return (
    <div className="stack">
      <div className="ops-toolbar">
        <span className="t-cap">Receiving adds the parts to stock and makes the receipt cost the part’s cost. The vendor invoice goes to Merit Books AP.</span>
        <span className="sp" />
        {!readOnly && p.companyId && <Button variant="primary" icon="plus" onClick={() => { setCreating(true); setCursor(null); }}>New stock order</Button>}
      </div>
      {!readOnly && !p.companyId && <PickStoreNote what="Parts orders" />}
      <Bands<Band> aria-label="Parts orders by status" value={band} onChange={setBand} items={BANDS.map((b) => ({ value: b.value, label: b.label, count: count(inBand(b.value).length), caption: b.caption }))} />
      <div className={creating || cur ? 'ops-split has-panel' : 'ops-split'}>
        <div className="mp-table" style={{ minWidth: 0 }}>
          {rows.length === 0 ? (
            <WidgetState state={d.orders.length === 0
              ? { kind: 'empty', title: 'No parts orders yet', body: 'Start a stock order and fill it from your min/max: every stocked part below its minimum, ordered up to max, less what is already on order.', action: readOnly || !p.companyId ? undefined : <Button variant="primary" onClick={() => setCreating(true)}>New stock order</Button> }
              : { kind: 'done', title: `Nothing ${BANDS.find((b) => b.value === band)?.label.toLowerCase()}`, body: 'Pick another band above.' }} />
          ) : (
            <QueueTable aria-label="Parts orders" columns={columns} rows={rows} getRowId={(o) => o.id} cursorId={cursor} onCursorChange={(id) => { setCursor(id); setCreating(false); }} onOpen={(o) => setCursor(o.id)} rowState={(o) => ({ attn: o.status === 'PARTIAL' })} />
          )}
        </div>
        {creating && p.companyId ? (
          <NewOrderPanel companyId={p.companyId} stockLocations={p.stockLocations.filter((s) => s.location_id === p.companyId)} defaultStockLocationId={p.defaultStockLocationId} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setCursor(id); setBand('DRAFT'); }} />
        ) : cur ? (
          <OrderPanel key={cur.id} order={cur} data={d} stockLocations={p.stockLocations} onClose={() => setCursor(null)} />
        ) : null}
      </div>
    </div>
  );
}

function NewOrderPanel({ companyId, stockLocations, defaultStockLocationId, onClose, onCreated }: { companyId: string; stockLocations: StockLocationRow[]; defaultStockLocationId: string | null; onClose: () => void; onCreated: (id: string) => void }) {
  const { act, busy, error } = useStore();
  const [vendor, setVendor] = useState<LookupItem | null>(null);
  const [sl, setSl] = useState(defaultStockLocationId ?? stockLocations[0]?.id ?? '');
  const [kind, setKind] = useState<'STOCK' | 'EMERGENCY'>('STOCK');
  const [ref, setRef] = useState('');
  const [suggest, setSuggest] = useState<SuggestedLine[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [keep, setKeep] = useState<Record<string, number>>({});
  const loadSuggest = async () => {
    if (!sl) return;
    setLoading(true); setLoadErr(null);
    const r = await api.get<{ lines: SuggestedLine[] }>('/api/dealer/parts-orders', { stockLocationId: sl });
    setLoading(false);
    if (r.error) { setLoadErr(r.error.error); return; }
    setSuggest(r.data?.lines ?? []);
    setKeep(Object.fromEntries((r.data?.lines ?? []).filter((l) => l.suggested_qty > 0).map((l) => [l.part_id, l.suggested_qty])));
  };
  const submit = async () => {
    if (!vendor || !sl) return;
    const lines = Object.entries(keep).filter(([, q]) => q > 0).map(([partId, qty]) => ({ partId, qty }));
    const r = await act<{ orderId: string; number: string | null }>('create', 'post', '/api/dealer/parts-orders', { companyId, vendorId: vendor.id, stockLocationId: sl, kind, vendorRef: ref.trim() || null, lines }, (x) => `Started ${x.number ?? 'the order'}${lines.length ? ` with ${lines.length} lines` : ''}`);
    if (r.data) onCreated(r.data.orderId);
  };
  return (
    <Panel eyebrow={['Parts', 'Stock order']} title="New stock order" meta="Draft until you submit it" onClose={onClose}
      foot={<div className="btn-row" style={{ width: '100%' }}><Button onClick={onClose}>Cancel</Button><span className="sp" /><Button variant="primary" disabled={!vendor || !sl || busy === 'create'} onClick={() => void submit()}>Start the order</Button></div>}>
      <PanelSection>
        <div className="mp-form">
          <Field label="Vendor"><Lookup kind="vendors" value={vendor ? { id: vendor.id, label: vendor.label } : null} onChange={setVendor} placeholder="OEM or distributor" /></Field>
          <div className="mp-form-2">
            <Field label="Into"><Select value={sl} onChange={(e) => { setSl(e.target.value); setSuggest(null); }}>{stockLocations.map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}</Select></Field>
            <Field label="Kind"><Select value={kind} onChange={(e) => setKind(e.target.value as 'STOCK' | 'EMERGENCY')}><option value="STOCK">Stock order</option><option value="EMERGENCY">Emergency</option></Select></Field>
          </div>
          <Field label="Vendor reference"><Input value={ref} onChange={(e) => setRef(e.target.value)} maxLength={60} /></Field>
          <div><Button disabled={!sl || loading} onClick={() => void loadSuggest()}>{loading ? 'Reading min/max…' : 'Fill from min/max'}</Button></div>
          {loadErr && <Failure text={loadErr} title="No suggestions." />}
          {error && <Failure text={error} title="Not started." />}
        </div>
      </PanelSection>
      {suggest && (
        <PanelSection title="Suggested lines" meta={<span className="t-cap">{count(suggest.length)} below min</span>}>
          {suggest.length === 0 ? <p className="t-cap">Nothing is below its minimum after what is on order. Add lines by hand once the order is started.</p> : (
            <table className="dl-tbl">
              <thead><tr><th>Part</th><th className="n">On hand</th><th className="n">On order</th><th className="n">Min / max</th><th className="n">Order</th></tr></thead>
              <tbody>
                {suggest.map((l) => (
                  <tr key={l.part_id}>
                    <td className="b">{l.part_number}</td>
                    <td className="n">{count(l.on_hand)}</td>
                    <td className="n">{count(l.on_order)}</td>
                    <td className="n">{count(l.min_qty)} / {l.max_qty == null ? '—' : count(l.max_qty)}</td>
                    <td className="n"><Input aria-label={`Order quantity for ${l.part_number}`} inputMode="decimal" defaultValue={String(l.suggested_qty)} style={{ width: 64 }} onChange={(e) => setKeep((k) => ({ ...k, [l.part_id]: parseNum(e.target.value) ?? 0 }))} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </PanelSection>
      )}
    </Panel>
  );
}

function OrderPanel({ order: o, data: d, stockLocations, onClose }: { order: PartsOrderRow; data: PartsOrderList; stockLocations: StockLocationRow[]; onClose: () => void }) {
  const { readOnly } = useShell();
  const { act, busy, error } = useStore();
  const url = `/api/dealer/parts-orders/${o.id}`;
  const lines = useMemo(() => d.lines.filter((l) => l.order_id === o.id), [d.lines, o.id]);
  const [recv, setRecv] = useState<Record<string, string>>({});
  const [pn, setPn] = useState('');
  const [qty, setQty] = useState('1');
  const [addErr, setAddErr] = useState<string | null>(null);
  const [submitOpen, setSubmitOpen] = useState(false);
  const draft = o.status === 'DRAFT' && !readOnly;
  const receiving = (o.status === 'SUBMITTED' || o.status === 'PARTIAL') && !readOnly;
  const total = lines.reduce((s, l) => s + Math.round(l.qty_ordered * (l.unit_cost_cents ?? 0)), 0);

  const addByNumber = async () => {
    setAddErr(null);
    const q = parseNum(qty);
    if (!pn.trim() || !q || q <= 0) return setAddErr('Key a part number and a quantity.');
    const r = await api.get<CounterSearch>('/api/dealer/parts', { companyId: o.location_id, pn: pn.trim() });
    const m = r.data?.matches ?? [];
    if (!m.length) return setAddErr(`${pn.trim().toUpperCase()} is not in the catalog.`);
    if (new Set(m.map((x) => x.resolved.id)).size > 1) return setAddErr('That number is carried for more than one line; add it from the catalog.');
    const res = await act('add', 'post', url, { op: 'add_lines', lines: [{ partId: m[0]!.resolved.id, qty: q }] }, `Added ${m[0]!.resolved.part_number}`);
    if (res.data) { setPn(''); setQty('1'); }
  };

  return (
    <Panel eyebrow={['Parts order', o.number]} title={d.vendors[o.vendor_id] ?? 'Vendor'} meta={`${stockLocations.find((s) => s.id === o.stock_location_id)?.name ?? 'Stock'} · ${PARTS_ORDER_STATUS[o.status].word}`} figure={money(total)} onClose={onClose}
      foot={readOnly ? undefined : (
        <div className="btn-row" style={{ width: '100%' }}>
          {draft && <Button variant="primary" disabled={!lines.length || busy === 'submit'} onClick={() => setSubmitOpen(true)}>Submit to the vendor</Button>}
          {receiving && (
            <>
              <Button disabled={busy === 'recv'} onClick={() => void act('recv', 'post', url, { op: 'receive', lines: lines.map((l) => ({ lineId: l.id, qty: parseNum(recv[l.id] ?? '') ?? 0 })).filter((l) => l.qty > 0) }, 'Received the keyed quantities')}>Receive keyed</Button>
              <span className="sp" />
              <Button variant="primary" disabled={busy === 'recv'} onClick={() => void act('recv', 'post', url, { op: 'receive', lines: null }, 'Received everything still open')}>Receive all open</Button>
            </>
          )}
        </div>
      )}>
      <PanelSection>
        {error && <Failure text={error} />}
        <table className="dl-tbl">
          <thead><tr><th>Part</th><th className="n">Ordered</th><th className="n">Received</th><th className="n">Cost each</th>{receiving && <th className="n">Receive</th>}{draft && <th />}</tr></thead>
          <tbody>
            {lines.length === 0 && <tr><td colSpan={5} className="t-cap">No lines yet. Add them by part number below.</td></tr>}
            {lines.map((l) => (
              <tr key={l.id}>
                <td><span className="l1 b">{d.parts[l.part_id]?.part_number ?? 'Part'}</span><span className="l2">{d.parts[l.part_id]?.description ?? ''}{l.special_order_id ? ' · special order' : ''}</span></td>
                <td className="n">{count(l.qty_ordered)}</td>
                <td className="n"><span className={l.qty_received < l.qty_ordered && o.status !== 'DRAFT' ? 'warn b' : undefined}>{count(l.qty_received)}</span></td>
                <td className="n">{l.unit_cost_cents == null ? '—' : money(l.unit_cost_cents)}</td>
                {receiving && <td className="n">{l.qty_received < l.qty_ordered ? <Input aria-label={`Receive quantity for ${d.parts[l.part_id]?.part_number ?? 'part'}`} inputMode="decimal" value={recv[l.id] ?? ''} placeholder={String(l.qty_ordered - l.qty_received)} onChange={(e) => setRecv({ ...recv, [l.id]: e.target.value })} style={{ width: 64 }} /> : '✓'}</td>}
                {draft && <td><Button variant="quiet" iconOnly icon="x" aria-label="Remove the line" disabled={busy === `rm:${l.id}`} onClick={() => void act(`rm:${l.id}`, 'post', url, { op: 'remove_line', lineId: l.id }, 'Removed the line')} /></td>}
              </tr>
            ))}
          </tbody>
        </table>
      </PanelSection>
      {draft && (
        <PanelSection title="Add a line">
          <form className="row" style={{ gap: 8, alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); void addByNumber(); }}>
            <Field label="Part number" error={addErr ?? undefined}><Input value={pn} onChange={(e) => setPn(e.target.value)} maxLength={40} autoCapitalize="characters" /></Field>
            <Field label="Qty"><Input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} style={{ width: 70 }} /></Field>
            <Button type="submit" icon="plus" disabled={busy === 'add'}>Add</Button>
          </form>
        </PanelSection>
      )}
      <ConfirmDialog open={submitOpen} onClose={() => setSubmitOpen(false)} title={`Submit ${o.number}`} confirmLabel="Submit the order" cancelLabel="Keep the draft"
        onConfirm={async () => { const r = await act('submit', 'post', url, { op: 'submit' }, `Submitted ${o.number}`); if (r.error) throw new Error(r.error.error); }}>
        {lines.length} line{lines.length === 1 ? '' : 's'} at {money(total)}. The lines lock and special orders on it move to ordered.
      </ConfirmDialog>
    </Panel>
  );
}
