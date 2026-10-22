'use client';

import { useMemo, useState } from 'react';
import {
  Button, Field, Input, KV, Meter, MoneyInput, Panel, PanelSection, QueueTable, Search, Seg, Select, Tag, WidgetState, count, money, pct, shortDate,
  stepStrokes, useEscapeKey, type QueueColumn,
} from '@meritbooks/merit-ui';
import { ITEM_NEXT, ITEM_PATH, ITEM_STATUS, ITEM_VERB, METHOD_WORDS } from '@/lib/pm/ops/labels';
import { itemTotals, markupText, sellFromMarkup } from '@/lib/pm/ops/selection-math';
import { APPROVAL_METHODS, type ApprovalMethod, type ClientApprovalRow, type ItemStatus, type LookupItem, type ProcurementRow } from '@/lib/pm/ops/types';
import type { JobOption } from '@/lib/pm/ops/scope';
import { stamp } from '@/lib/time';
import { useMoneyVis, useShell, useVocab } from '@/components/shell/ShellContext';
import { seesMargin, when } from '@/components/money/visibility';
import { lower } from '@/lib/pm/vocab';
import { Failure, JobSelect, PctInput, StatusMark, parseNum } from '../common/bits';
import { Lookup } from '../common/Lookup';
import { useDetail, useOps } from '../common/useOps';

type Show = 'open' | 'late' | 'all';
const DONE: ReadonlySet<ItemStatus> = new Set(['INSTALLED', 'DELIVERED', 'RETURNED', 'CANCELLED']);

export interface ProcurementListProps {
  rows: ProcurementRow[];
  jobs: JobOption[];
  vendors: Record<string, string>;
  storage: Array<{ id: string; code: string; name: string; kind: string }>;
  today: string;
  fixedJobId?: string | null;
}

export function ProcurementList(p: ProcurementListProps) {
  const v = useVocab();
  const { readOnly } = useShell();
  const [show, setShow] = useState<Show>('open');
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const jobs = useMemo(() => new Map(p.jobs.map((j) => [j.id, j])), [p.jobs]);
  const filtered = p.rows.filter((r) => {
    if (show === 'open' && DONE.has(r.status)) return false;
    if (show === 'late' && !r.is_overdue) return false;
    const t = q.trim().toLowerCase();
    return !t || [r.description, r.sidemark, r.po_number, r.vendor_id ? p.vendors[r.vendor_id] : null, jobs.get(r.job_id)?.label].filter(Boolean).join(' ').toLowerCase().includes(t);
  });
  const cur = p.rows.find((r) => r.item_id === cursor) ?? null;
  const sell = filtered.reduce((s, r) => s + r.sell_total_cents, 0);
  const cost = filtered.reduce((s, r) => s + r.cost_total_cents, 0);
  const late = p.rows.filter((r) => r.is_overdue).length;
  // Cost is financials, sell is contract_value, markup and margin need both.
  const mv = useMoneyVis();
  const both = seesMargin(mv);

  const columns: QueueColumn<ProcurementRow>[] = [
    { id: 'item', header: 'Item', cell: (r) => <><span className="l1">{r.description}</span><span className="l2">{[r.sidemark ? `Sidemark ${r.sidemark}` : null, r.vendor_id ? p.vendors[r.vendor_id] : null, !p.fixedJobId ? jobs.get(r.job_id)?.label : null].filter(Boolean).join(' · ') || ' '}</span></> },
    { id: 'qty', header: 'Qty', numeric: true, width: 80, cell: (r) => `${r.qty} ${r.uom}` },
    ...when<QueueColumn<ProcurementRow>>(mv.cost, { id: 'cost', header: 'Cost', numeric: true, width: 112, cell: (r) => money(r.cost_total_cents) }),
    ...when<QueueColumn<ProcurementRow>>(both, { id: 'mk', header: 'Markup', numeric: true, width: 80, cell: (r) => markupText(r.markup_pct) }),
    ...when<QueueColumn<ProcurementRow>>(mv.contract, { id: 'sell', header: 'Sell', numeric: true, width: 112, cell: (r) => money(r.sell_total_cents) }),
    ...when<QueueColumn<ProcurementRow>>(both, { id: 'mg', header: 'Margin', numeric: true, width: 80, cell: (r) => (r.margin_pct == null ? '—' : pct(r.margin_pct)) }),
    { id: 'st', header: 'Status', width: 140, cell: (r) => <StatusMark mark={ITEM_STATUS[r.status]} /> },
    { id: 'when', header: 'Next date', width: 120, cell: (r) => {
      if (r.installed_on) return <><span className="l1">{shortDate(r.installed_on, p.today)}</span><span className="l2">installed</span></>;
      if (r.status === 'STORED' && r.days_in_storage != null) return <><span className="l1">{r.days_in_storage} days</span><span className="l2">in storage</span></>;
      if (r.received_on) return <><span className="l1">{shortDate(r.received_on, p.today)}</span><span className="l2">received</span></>;
      if (r.expected_on) return <><span className={r.is_overdue ? 'l1 neg b' : 'l1'}>{shortDate(r.expected_on, p.today)}</span><span className="l2">{r.is_overdue ? 'past expected' : 'expected'}</span></>;
      return <span className="l2">—</span>;
    } },
  ];

  return (
    <div className="stack">
      <div className="ops-toolbar">
        <div style={{ width: 280 }}><Search aria-label="Find an item" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Item, sidemark, PO or vendor" /></div>
        <Seg<Show> aria-label="Show" value={show} onChange={setShow} items={[{ value: 'open', label: 'Open' }, { value: 'late', label: 'Past expected', count: late }, { value: 'all', label: 'All', count: p.rows.length }]} />
        <span className="sp" />
        {both ? <span className="t-cap">{money(sell)} sell · {money(sell - cost)} margin{sell > 0 ? ` (${pct((sell - cost) / sell)})` : ''}</span>
          : mv.contract ? <span className="t-cap">{money(sell)} sell</span> : mv.cost ? <span className="t-cap">{money(cost)} cost</span> : null}
        {!readOnly && <Button variant="primary" icon="plus" onClick={() => { setCreating(true); setCursor(null); }}>New item</Button>}
      </div>
      <div className={creating || cur ? 'ops-split has-panel' : 'ops-split'}>
        <div className="mp-table" style={{ minWidth: 0 }}>
          {filtered.length === 0 ? (
            <WidgetState state={p.rows.length === 0
              ? { kind: 'empty', title: 'Nothing is being purchased yet', body: `Approved ${lower(v.selections)} send their chosen option here, or add an item directly: cost, markup, sell, then order, receive, store and install.`, action: readOnly ? undefined : <Button variant="primary" onClick={() => setCreating(true)}>New item</Button> }
              : { kind: 'done', title: show === 'late' ? 'Nothing is past its expected date' : 'Nothing open', body: 'Switch the view above to see the others.' }} />
          ) : (
            <QueueTable aria-label="Purchasing" columns={columns} rows={filtered} getRowId={(r) => r.item_id} cursorId={cursor} onCursorChange={(id) => { setCursor(id); setCreating(false); }} onOpen={(r) => setCursor(r.item_id)}
              rowState={(r) => ({ done: r.status === 'CANCELLED' || r.status === 'RETURNED' || r.status === 'INSTALLED', attn: !!r.is_overdue || r.status === 'DAMAGED' })} />
          )}
        </div>
        {creating ? (
          <NewItemPanel jobs={p.jobs.filter((j) => j.open)} fixedJobId={p.fixedJobId} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setCursor(id); }} />
        ) : cur ? (
          <ItemPanel key={cur.item_id} item={cur} jobLabel={jobs.get(cur.job_id)?.label ?? null} customerName={jobs.get(cur.job_id)?.customer ?? null} vendor={cur.vendor_id ? p.vendors[cur.vendor_id] ?? null : null} storage={p.storage} today={p.today} onClose={() => setCursor(null)} />
        ) : null}
      </div>
    </div>
  );
}

function ItemPanel({ item, jobLabel, customerName, vendor, storage, today, onClose }: { item: ProcurementRow; jobLabel: string | null; customerName: string | null; vendor: string | null; storage: ProcurementListProps['storage']; today: string; onClose: () => void }) {
  const { readOnly } = useShell();
  const { act, busy, version, error } = useOps();
  const { data } = useDetail<{ approvals: ClientApprovalRow[] }>(`/api/ops/items/${item.item_id}`, version);
  const [to, setTo] = useState<ItemStatus | null>(null);
  const url = `/api/ops/items/${item.item_id}`;
  const pathIdx = ITEM_PATH.indexOf(item.status);
  const priced = item.status === 'SPECIFIED' || item.status === 'PROPOSED';
  const mv = useMoneyVis();
  const storeName = item.storage_location_id ? storage.find((s) => s.id === item.storage_location_id)?.name ?? 'Storage' : null;
  return (
    <Panel eyebrow={['Item', ITEM_STATUS[item.status].word]} title={item.description} meta={[jobLabel, item.sidemark ? `Sidemark ${item.sidemark}` : null].filter(Boolean).join(' · ')} onClose={onClose}>
      <PanelSection>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <StatusMark mark={ITEM_STATUS[item.status]} />
          {pathIdx >= 0 && <Meter strokes={stepStrokes(ITEM_PATH.length, item.status === 'INSTALLED' ? ITEM_PATH.length : pathIdx)} label={`Step ${pathIdx + 1} of ${ITEM_PATH.length}: ${ITEM_STATUS[item.status].word}`} />}
          {item.is_overdue && <Tag tone="neg">Past expected</Tag>}
        </div>
        <div style={{ marginTop: 12 }}>
          <KV items={[
            ...(vendor ? [{ term: 'Vendor', value: vendor }] : []),
            ...when(mv.cost, { term: 'Cost', value: `${money(item.cost_total_cents)}${item.freight_cents ? ` incl. ${money(item.freight_cents)} freight` : ''}` }),
            ...when(mv.contract, { term: 'Sell', value: `${money(item.sell_total_cents)}${item.markup_pct != null && seesMargin(mv) ? ` · ${markupText(item.markup_pct)} markup` : ''}` }),
            ...when(seesMargin(mv), { term: 'Margin', value: `${money(item.margin_cents)}${item.margin_pct != null ? ` · ${pct(item.margin_pct)}` : ''}` }),
            ...(item.po_number ? [{ term: 'PO', value: item.po_number }] : []),
            ...(item.expected_on ? [{ term: 'Expected', value: shortDate(item.expected_on, today) }] : []),
            ...(item.received_on ? [{ term: 'Received', value: shortDate(item.received_on, today) }] : []),
            ...(storeName ? [{ term: 'Stored at', value: `${storeName}${item.days_in_storage != null ? `, ${item.days_in_storage} days` : ''}` }] : []),
            ...(item.install_on ? [{ term: 'Install day', value: shortDate(item.install_on, today) }] : []),
            ...(item.installed_on ? [{ term: 'Installed', value: shortDate(item.installed_on, today) }] : []),
          ]} />
        </div>
        <p className="t-cap" style={{ marginTop: 8 }}>The vendor PO and the client invoice are documents in Merit Books; this tracks the item itself.</p>
        {error && <div style={{ marginTop: 8 }}><Failure text={error} /></div>}
      </PanelSection>

      {!readOnly && ITEM_NEXT[item.status].length > 0 && (
        <PanelSection title="Next">
          <div className="btn-row" style={{ flexWrap: 'wrap' }}>
            {ITEM_NEXT[item.status].map((s, i) => <Button key={s} variant={i === 0 ? 'primary' : 'default'} aria-pressed={to === s} onClick={() => setTo(to === s ? null : s)}>{ITEM_VERB[s]}</Button>)}
          </div>
          {to && <AdvanceForm to={to} item={item} customerName={customerName} storage={storage} today={today} busy={busy === 'adv'} onCancel={() => setTo(null)}
            onSubmit={async (b) => { const r = await act('adv', 'post', url, { op: 'advance', to, ...b }, `${item.description}: ${ITEM_STATUS[to].word.toLowerCase()}`); if (r) setTo(null); }} />}
        </PanelSection>
      )}

      {!readOnly && priced && seesMargin(mv) && <PricingForm item={item} busy={busy === 'price'} onSave={(b) => void act('price', 'post', url, { op: 'update', ...b }, 'Saved the pricing')} />}

      {data && data.approvals.length > 0 && (
        <PanelSection title="Client approval on record">
          {data.approvals.map((a) => (
            <div key={a.id} className="ops-record" style={{ marginBottom: 8 }}>
              <p className="b">Approved by {a.approver_name}</p>
              <p className="t-cap">{METHOD_WORDS[a.method]} · {stamp(a.decided_at)}{a.amount_cents != null ? ` · ${money(a.amount_cents)}` : ''}</p>
            </div>
          ))}
        </PanelSection>
      )}
    </Panel>
  );
}

function AdvanceForm({ to, item, customerName, storage, today, busy, onCancel, onSubmit }: {
  to: ItemStatus; item: ProcurementRow; customerName: string | null; storage: ProcurementListProps['storage']; today: string; busy: boolean; onCancel: () => void;
  onSubmit: (b: { on: string | null; attrs: Record<string, unknown> }) => void;
}) {
  const [on, setOn] = useState(today);
  const [name, setName] = useState(customerName ?? '');
  const [method, setMethod] = useState<ApprovalMethod>('IN_PERSON');
  const [po, setPo] = useState('');
  const [expected, setExpected] = useState(item.expected_on ?? '');
  const [tracking, setTracking] = useState('');
  const [rqty, setRqty] = useState(String(item.qty));
  const [cond, setCond] = useState<'GOOD' | 'DAMAGED' | 'PARTIAL' | 'WRONG_ITEM'>('GOOD');
  const [store, setStore] = useState(item.storage_location_id ?? '');
  const [note, setNote] = useState('');
  const submit = () => {
    const attrs: Record<string, unknown> = {};
    if (to === 'APPROVED') { if (name.trim()) attrs.approverName = name.trim(); attrs.method = method; }
    if (to === 'ORDERED') { if (po.trim()) attrs.poNumber = po.trim(); if (expected) attrs.expectedOn = expected; }
    if (to === 'ACKNOWLEDGED' || to === 'BACK_ORDERED') { if (expected) attrs.expectedOn = expected; }
    if (to === 'SHIPPED') { if (tracking.trim()) attrs.trackingRef = tracking.trim(); if (expected) attrs.expectedOn = expected; }
    if (to === 'RECEIVED') { attrs.receivedQty = parseNum(rqty) ?? item.qty; attrs.receivedCondition = cond; if (store) attrs.storageLocationId = store; }
    if (to === 'STORED' && store) attrs.storageLocationId = store;
    if (note.trim()) attrs.note = note.trim();
    onSubmit({ on: on || null, attrs });
  };
  return (
    <form className="mp-form" style={{ marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); submit(); }}>
      {to === 'APPROVED' && (
        <div className="mp-form-2">
          <Field label="Approved by" help="Not needed when it came from an approved selection"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={200} /></Field>
          <Field label="How"><Select value={method} onChange={(e) => setMethod(e.target.value as ApprovalMethod)}>{APPROVAL_METHODS.map((m) => <option key={m} value={m}>{METHOD_WORDS[m]}</option>)}</Select></Field>
        </div>
      )}
      {to === 'ORDERED' && <Field label="PO number"><Input autoFocus value={po} onChange={(e) => setPo(e.target.value)} maxLength={60} /></Field>}
      {(to === 'ORDERED' || to === 'ACKNOWLEDGED' || to === 'BACK_ORDERED' || to === 'SHIPPED') && <Field label="Expected"><Input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} /></Field>}
      {to === 'SHIPPED' && <Field label="Tracking"><Input value={tracking} onChange={(e) => setTracking(e.target.value)} maxLength={120} /></Field>}
      {to === 'RECEIVED' && (
        <div className="mp-form-2">
          <Field label="Quantity received"><Input inputMode="decimal" value={rqty} onChange={(e) => setRqty(e.target.value)} /></Field>
          <Field label="Condition"><Select value={cond} onChange={(e) => setCond(e.target.value as typeof cond)}><option value="GOOD">Good</option><option value="PARTIAL">Partial</option><option value="DAMAGED">Damaged</option><option value="WRONG_ITEM">Wrong item</option></Select></Field>
        </div>
      )}
      {(to === 'RECEIVED' || to === 'STORED') && (
        <Field label="Where it is kept">
          <Select value={store} onChange={(e) => setStore(e.target.value)}>
            <option value="">{storage.length ? 'Not in storage' : 'No storage locations set up'}</option>
            {storage.map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}
          </Select>
        </Field>
      )}
      {to !== 'APPROVED' && to !== 'PROPOSED' && to !== 'SPECIFIED' && <Field label="On"><Input type="date" value={on} onChange={(e) => setOn(e.target.value)} /></Field>}
      {(to === 'DAMAGED' || to === 'RETURNED' || to === 'CANCELLED' || to === 'BACK_ORDERED') && <Field label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} placeholder={to === 'DAMAGED' ? 'Corner crushed; freight claim opened' : ''} /></Field>}
      <div className="btn-row"><Button onClick={onCancel}>Back</Button><Button type="submit" variant="primary" disabled={busy}>{ITEM_VERB[to]}</Button></div>
    </form>
  );
}

function PricingForm({ item, busy, onSave }: { item: ProcurementRow; busy: boolean; onSave: (b: { unitCostCents: number | null; markupPct: number | null; unitSellCents: number | null; freightCents: number }) => void }) {
  const [cost, setCost] = useState<number | null>(item.unit_cost_cents);
  const [markup, setMarkup] = useState<number | null>(item.markup_pct);
  const [sell, setSell] = useState<number | null>(item.unit_sell_cents);
  const [freight, setFreight] = useState<number | null>(item.freight_cents);
  const derived = sell ?? sellFromMarkup(cost, markup);
  const t = itemTotals(item.qty, cost, derived, freight ?? 0);
  return (
    <PanelSection title="Pricing" meta="Pinned once the client approves">
      <form className="mp-form" onSubmit={(e) => { e.preventDefault(); onSave({ unitCostCents: cost, markupPct: markup, unitSellCents: sell, freightCents: freight ?? 0 }); }}>
        <div className="mp-form-2">
          <Field label="Net cost each"><MoneyInput valueCents={cost} onChangeCents={setCost} /></Field>
          <Field label="Markup"><PctInput value={markup} onChange={setMarkup} max={10000} /></Field>
        </div>
        <div className="mp-form-2">
          <Field label="Sell each" help="Blank uses cost and markup"><MoneyInput valueCents={sell} onChangeCents={setSell} placeholder={derived != null ? money(derived) : ''} /></Field>
          <Field label="Freight and receiving"><MoneyInput valueCents={freight} onChangeCents={setFreight} /></Field>
        </div>
        <p className="t-cap">{money(t.sell)} sell, {money(t.cost)} cost, {money(t.margin)} margin{t.marginPct != null ? ` (${pct(t.marginPct)})` : ''}.</p>
        <div><Button type="submit" disabled={busy}>Save pricing</Button></div>
      </form>
    </PanelSection>
  );
}

function NewItemPanel({ jobs, fixedJobId, onClose, onCreated }: { jobs: JobOption[]; fixedJobId?: string | null; onClose: () => void; onCreated: (id: string) => void }) {
  const v = useVocab();
  const mv = useMoneyVis();
  const prices = seesMargin(mv);
  const { act, busy, error } = useOps();
  const [jobId, setJobId] = useState(fixedJobId ?? '');
  const [desc, setDesc] = useState('');
  const [vendor, setVendor] = useState<LookupItem | null>(null);
  const [sku, setSku] = useState('');
  const [sidemark, setSidemark] = useState('');
  const [qty, setQty] = useState('1');
  const [uom, setUom] = useState('EA');
  const [cost, setCost] = useState<number | null>(null);
  const [markup, setMarkup] = useState<number | null>(null);
  const [sell, setSell] = useState<number | null>(null);
  const [freight, setFreight] = useState<number | null>(null);
  const [expected, setExpected] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEscapeKey(onClose, busy !== 'create', 'New item');
  const q = parseNum(qty);
  const t = itemTotals(q ?? 0, cost, sell ?? sellFromMarkup(cost, markup), freight ?? 0);
  const submit = async () => {
    if (!jobId) return setErr(`Pick the ${lower(v.job)}.`);
    if (!desc.trim()) return setErr('Describe the item.');
    if (q == null || q <= 0) return setErr('Quantity must be more than 0.');
    setErr(null);
    const r = await act<{ itemId: string }>('create', 'post', '/api/ops/items', { jobId, description: desc.trim(), vendorId: vendor?.id ?? null, vendorSku: sku.trim() || null, sidemark: sidemark.trim() || null, qty: q, uom: uom.trim() || null, unitCostCents: cost, markupPct: markup, unitSellCents: sell, freightCents: freight ?? 0, expectedOn: expected || null }, `Added ${desc.trim()}`);
    if (r) onCreated(r.itemId);
  };
  return (
    <Panel eyebrow={['New', 'Item']} title={desc.trim() || 'New item'} meta="Starts as specified" onClose={onClose}
      foot={<div className="btn-row" style={{ justifyContent: 'flex-end', width: '100%' }}><Button onClick={onClose}>Cancel</Button><Button variant="primary" chord="mod+enter" bindChord disabled={busy === 'create'} onClick={() => void submit()}>Create</Button></div>}>
      <PanelSection>
        <form className="mp-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          {!fixedJobId && <Field label={v.job}><JobSelect jobs={jobs} value={jobId} onChange={setJobId} /></Field>}
          <Field label="Item" error={err ?? undefined}><Input autoFocus value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Swivel chair, COM in Kravet 3456" maxLength={300} /></Field>
          <Field label="Vendor"><Lookup kind="vendors" value={vendor ? { id: vendor.id, label: vendor.label } : null} onChange={setVendor} placeholder="Search vendors" /></Field>
          <div className="mp-form-2">
            <Field label="Vendor SKU"><Input value={sku} onChange={(e) => setSku(e.target.value)} maxLength={80} /></Field>
            <Field label="Sidemark"><Input value={sidemark} onChange={(e) => setSidemark(e.target.value)} placeholder="SMITH / LIVING" maxLength={120} /></Field>
          </div>
          <div className="mp-form-2">
            <Field label="Quantity"><div className="row" style={{ gap: 8 }}><Input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} style={{ width: 88 }} /><Input aria-label="Unit" value={uom} onChange={(e) => setUom(e.target.value)} style={{ width: 72 }} maxLength={12} /></div></Field>
            <Field label="Expected"><Input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} /></Field>
          </div>
          <div className="mp-form-2">
            {prices && <Field label="Net cost each"><MoneyInput valueCents={cost} onChangeCents={setCost} placeholder="0.00" /></Field>}
            {prices && <Field label="Markup"><PctInput value={markup} onChange={setMarkup} placeholder="35" max={10000} /></Field>}
          </div>
          <div className="mp-form-2">
            {prices && <Field label="Sell each" help="Blank uses cost and markup"><MoneyInput valueCents={sell} onChangeCents={setSell} /></Field>}
            {prices && <Field label="Freight and receiving"><MoneyInput valueCents={freight} onChangeCents={setFreight} placeholder="0.00" /></Field>}
          </div>
          {prices ? <p className="t-cap">{money(t.sell)} sell · {money(t.cost)} cost · {money(t.margin)} margin{t.marginPct != null ? ` (${pct(t.marginPct)})` : ''}</p> : <p className="t-cap">Purchasing prices it.</p>}
          <Failure text={error} />
          <button type="submit" hidden />
        </form>
      </PanelSection>
    </Panel>
  );
}

export function procurementCount(rows: ReadonlyArray<ProcurementRow>): string {
  return count(rows.filter((r) => !DONE.has(r.status)).length);
}
