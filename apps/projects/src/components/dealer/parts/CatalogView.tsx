'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Button, Field, Input, Keybar, MoneyInput, Panel, PanelSection, QueueTable, Search, Seg, Status, Tag, WidgetState, count, money, type QueueColumn,
} from '@meritbooks/merit-ui';
import type { PartOnHandRow, PartRow, StockLocationRow } from '@/lib/pm/dealer/types';
import type { LookupItem } from '@/lib/pm/ops/types';
import { useMoneyVis, useShell } from '@/components/shell/ShellContext';
import { when } from '@/components/money/visibility';
import { CustomerPicker, type CustomerValue } from '@/components/jobs/CustomerPicker';
import { Failure, parseNum } from '@/components/ops/common/bits';
import { Lookup } from '@/components/ops/common/Lookup';
import { PickStoreNote } from '../common/StoreOff';
import { useStore } from '../common/useStore';

type Filter = 'all' | 'below' | 'stocked' | 'superseded';

interface CatalogRow {
  part: PartRow;
  onHand: number;
  onOrder: number;
  min: number | null;
  below: boolean;
  bins: string[];
  rows: PartOnHandRow[];
}

export interface CatalogViewProps {
  parts: PartRow[];
  onHand: PartOnHandRow[];
  vendors: Record<string, string>;
  stockLocations: StockLocationRow[];
  companyId: string | null;
  capped: boolean;
  newNumber: string | null;
  initialFilter: Filter;
}

/** The parts catalog with on-hand, bins and min/max per stock location; below-minimum first when asked. */
export function CatalogView(p: CatalogViewProps) {
  // Part cost and stock value at cost are financials; counter and list prices are the sell side.
  const mv = useMoneyVis();
  const { readOnly } = useShell();
  const [filter, setFilter] = useState<Filter>(p.initialFilter);
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [creating, setCreating] = useState(!!p.newNumber && !!p.companyId && !readOnly);

  const rows = useMemo<CatalogRow[]>(() => {
    const by = new Map<string, PartOnHandRow[]>();
    for (const r of p.onHand) by.set(r.part_id, [...(by.get(r.part_id) ?? []), r]);
    return p.parts.map((part) => {
      const rs = by.get(part.id) ?? [];
      const mins = rs.map((r) => r.min_qty).filter((x): x is number => x != null);
      return {
        part, rows: rs,
        onHand: rs.reduce((s, r) => s + r.qty_on_hand, 0),
        onOrder: rs.reduce((s, r) => s + r.qty_on_order, 0),
        min: mins.length ? mins.reduce((a, b) => a + b, 0) : null,
        below: rs.some((r) => r.below_min),
        bins: rs.map((r) => r.bin).filter((b): b is string => !!b),
      };
    });
  }, [p.parts, p.onHand]);

  const visible = useMemo(() => {
    const t = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === 'below' && !r.below) return false;
      if (filter === 'stocked' && r.min == null) return false;
      if (filter === 'superseded' && r.part.status !== 'SUPERSEDED') return false;
      if (t && ![r.part.part_number, r.part.description, r.part.manufacturer, ...r.bins].filter(Boolean).join(' ').toLowerCase().includes(t)) return false;
      return true;
    }).sort((a, b) => (filter === 'below' ? ((b.min ?? 0) - b.onHand) - ((a.min ?? 0) - a.onHand) : 0));
  }, [rows, filter, q]);

  const byId = useMemo(() => new Map(p.parts.map((x) => [x.id, x])), [p.parts]);
  const cur = rows.find((r) => r.part.id === cursor) ?? null;
  const below = rows.filter((r) => r.below);
  const value = p.onHand.reduce((s, r) => s + r.extended_cost_cents, 0);

  const columns: QueueColumn<CatalogRow>[] = [
    { id: 'pn', header: 'Part number', width: 170, cell: (r) => <><span className="l1 code">{r.part.part_number}</span><span className="l2">{r.part.manufacturer ?? ' '}</span></> },
    { id: 'd', header: 'Description', cell: (r) => <><span className="l1">{r.part.description}</span><span className="l2">{r.part.status === 'SUPERSEDED' ? `Replaced by ${r.part.superseded_by_part_id ? byId.get(r.part.superseded_by_part_id)?.part_number ?? 'a newer number' : 'a newer number'}` : r.part.status === 'OBSOLETE' ? 'Obsolete' : r.part.category ?? ' '}</span></> },
    { id: 'bin', header: 'Bin', width: 100, cell: (r) => <span className="l2">{r.bins.join(', ') || '—'}</span> },
    { id: 'oh', header: 'On hand', numeric: true, width: 96, cell: (r) => <span className={r.below ? 'neg b' : undefined}>{count(r.onHand)}</span> },
    { id: 'mm', header: 'Min', numeric: true, width: 70, cell: (r) => (r.min == null ? '—' : count(r.min)) },
    { id: 'oo', header: 'On order', numeric: true, width: 90, cell: (r) => (r.onOrder ? count(r.onOrder) : '—') },
    { id: 'pr', header: 'Price', numeric: true, width: 100, cell: (r) => (r.part.price_cents == null ? '—' : money(r.part.price_cents)) },
    ...when<QueueColumn<CatalogRow>>(mv.cost, { id: 'c', header: 'Cost', numeric: true, width: 100, cell: (r) => (r.part.cost_cents == null ? '—' : money(r.part.cost_cents)) }),
  ];

  return (
    <div className="stack">
      <div className="ops-toolbar">
        <Seg<Filter> aria-label="Show" value={filter} onChange={setFilter} items={[
          { value: 'all', label: 'All parts', count: rows.length },
          { value: 'below', label: 'Below minimum', count: below.length },
          { value: 'stocked', label: 'Stocked', count: rows.filter((r) => r.min != null).length },
          { value: 'superseded', label: 'Superseded', count: rows.filter((r) => r.part.status === 'SUPERSEDED').length },
        ]} />
        <div style={{ width: 280 }}><Search aria-label="Find a part" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Number, description, bin" slashToFocus /></div>
        <span className="sp" />
        {mv.cost && <span className="t-cap">{money(value, { decimals: 0 })} on hand at last cost</span>}
        {!readOnly && p.companyId && <Button variant="primary" icon="plus" chord="n" bindChord={!creating} onClick={() => { setCreating(true); setCursor(null); }}>Add a part</Button>}
      </div>
      {!readOnly && !p.companyId && <PickStoreNote what="Parts" />}
      <div className={creating || cur ? 'ops-split has-panel' : 'ops-split'}>
        <div className="mp-table" style={{ minWidth: 0 }}>
          {visible.length === 0 ? (
            <WidgetState state={rows.length === 0
              ? { kind: 'empty', title: 'No parts in the catalog yet', body: 'Add parts by number with description, cost and counter price, then set a bin and min/max per stock location. The counter and repair orders sell from here.', action: readOnly || !p.companyId ? undefined : <Button variant="primary" onClick={() => setCreating(true)}>Add a part</Button> }
              : filter === 'below' ? { kind: 'done', title: 'Nothing is below its minimum', body: 'Every stocked part is at or above min. Stock orders suggest what to order as parts sell.' }
              : { kind: 'done', title: q ? `Nothing matches “${q}”` : 'Nothing in this view', body: 'Clear the search or pick another view.' }} />
          ) : (
            <QueueTable aria-label="Parts" columns={columns} rows={visible} getRowId={(r) => r.part.id} cursorId={cursor} onCursorChange={(id) => { setCursor(id); setCreating(false); }} onOpen={(r) => setCursor(r.part.id)}
              rowState={(r) => ({ attn: r.below, done: r.part.status !== 'ACTIVE' || !r.part.is_active })} />
          )}
          {p.capped && <p className="t-cap" style={{ padding: 12 }}>Showing the first 2,000 parts by number. Search narrows it.</p>}
        </div>
        {creating && p.companyId ? (
          <NewPartPanel companyId={p.companyId} initialNumber={p.newNumber} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setCursor(id); }} />
        ) : cur ? (
          <PartPanel key={cur.part.id} row={cur} vendors={p.vendors} stockLocations={p.stockLocations.filter((s) => s.location_id === cur.part.location_id && s.is_active)} byId={byId} onClose={() => setCursor(null)} />
        ) : null}
      </div>
      {visible.length > 0 && <Keybar hints={[{ chord: 'j k', label: 'move' }, { chord: 'enter', label: 'open' }, { chord: '/', label: 'find' }]} note="Costs are operational (last receipt); Merit Books values the inventory" />}
    </div>
  );
}

function NewPartPanel({ companyId, initialNumber, onClose, onCreated }: { companyId: string; initialNumber: string | null; onClose: () => void; onCreated: (id: string) => void }) {
  const mv = useMoneyVis();
  const { act, busy, error } = useStore();
  const [pn, setPn] = useState(initialNumber ?? '');
  const [desc, setDesc] = useState('');
  const [mfr, setMfr] = useState('');
  const [vendor, setVendor] = useState<LookupItem | null>(null);
  const [uom, setUom] = useState('EA');
  const [category, setCategory] = useState('');
  const [cost, setCost] = useState<number | null>(null);
  const [list, setList] = useState<number | null>(null);
  const [price, setPrice] = useState<number | null>(null);
  const [core, setCore] = useState<number | null>(null);
  const [err, setErr] = useState<Record<string, string>>({});
  const submit = async () => {
    const e: Record<string, string> = {};
    if (!pn.trim()) e.pn = 'Give the part number.';
    if (!desc.trim()) e.desc = 'Describe the part.';
    setErr(e);
    if (Object.keys(e).length) return;
    const r = await act<{ partId: string }>('part', 'post', '/api/dealer/parts', {
      companyId, partNumber: pn.trim(), description: desc.trim(), manufacturer: mfr.trim().toUpperCase() || null, mfrVendorId: vendor?.id ?? null, uom: uom.trim() || 'EA',
      category: category.trim() || null, costCents: cost, listPriceCents: list, priceCents: price, coreChargeCents: core,
    }, `Saved ${pn.trim().toUpperCase()}`);
    if (r.data) onCreated(r.data.partId);
  };
  return (
    <Panel eyebrow={['Parts', 'New']} title="Add a part" meta="Numbers already in the catalog are updated instead" onClose={onClose}
      foot={<div className="btn-row" style={{ width: '100%' }}><Button onClick={onClose}>Cancel</Button><span className="sp" /><Button variant="primary" chord="mod+enter" bindChord disabled={busy === 'part'} onClick={() => void submit()}>Save the part</Button></div>}>
      <PanelSection>
        <form className="mp-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <div className="mp-form-2">
            <Field label="Part number" error={err.pn}><Input autoFocus value={pn} onChange={(e) => setPn(e.target.value)} maxLength={40} autoCapitalize="characters" /></Field>
            <Field label="Line" help="OEM line code, e.g. KUBOTA"><Input value={mfr} onChange={(e) => setMfr(e.target.value)} maxLength={24} autoCapitalize="characters" /></Field>
          </div>
          <Field label="Description" error={err.desc}><Input value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={200} placeholder="Oil filter, BX series" /></Field>
          <div className="mp-form-2">
            <Field label="Manufacturer (vendor)"><Lookup kind="vendors" value={vendor ? { id: vendor.id, label: vendor.label } : null} onChange={setVendor} placeholder="Optional" /></Field>
            <Field label="Category"><Input value={category} onChange={(e) => setCategory(e.target.value)} maxLength={40} placeholder="Filters" /></Field>
          </div>
          <div className="mp-form-2">
            {mv.cost && <Field label="Cost"><MoneyInput valueCents={cost} onChangeCents={setCost} placeholder="0.00" /></Field>}
            <Field label="List price"><MoneyInput valueCents={list} onChangeCents={setList} placeholder="0.00" /></Field>
          </div>
          <div className="mp-form-2">
            <Field label="Counter price" help="Blank uses list"><MoneyInput valueCents={price} onChangeCents={setPrice} placeholder={list != null ? money(list) : '0.00'} /></Field>
            <Field label="Core charge"><MoneyInput valueCents={core} onChangeCents={setCore} placeholder="0.00" /></Field>
          </div>
          <Field label="Unit"><Input value={uom} onChange={(e) => setUom(e.target.value)} maxLength={12} style={{ width: 100 }} /></Field>
          {error && <Failure text={error} title="Not saved." />}
        </form>
      </PanelSection>
    </Panel>
  );
}

function PartPanel({ row, vendors, stockLocations, byId, onClose }: { row: CatalogRow; vendors: Record<string, string>; stockLocations: StockLocationRow[]; byId: Map<string, PartRow>; onClose: () => void }) {
  const mv = useMoneyVis();
  const { readOnly } = useShell();
  const { act, busy, error } = useStore();
  const part = row.part;
  const url = `/api/dealer/parts/${part.id}`;
  const [price, setPrice] = useState<number | null>(part.price_cents);
  const [list, setList] = useState<number | null>(part.list_price_cents);
  const [cost, setCost] = useState<number | null>(part.cost_cents);
  const [newPn, setNewPn] = useState('');
  const [soQty, setSoQty] = useState('1');
  const [soCustomer, setSoCustomer] = useState<CustomerValue>({ id: null, name: '' });
  useEffect(() => { setPrice(part.price_cents); setList(part.list_price_cents); setCost(part.cost_cents); }, [part.id, part.price_cents, part.list_price_cents, part.cost_cents]);
  const replacement = part.superseded_by_part_id ? byId.get(part.superseded_by_part_id) ?? null : null;
  const save = (patch: Record<string, unknown>, label: string) => void act('upd', 'post', url, { op: 'update', ...patch }, label);

  return (
    <Panel eyebrow={['Part', part.manufacturer ?? 'Catalog']} title={part.part_number} meta={part.description} figure={part.price_cents == null ? undefined : money(part.price_cents)} onClose={onClose}>
      <PanelSection>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {part.status === 'SUPERSEDED' ? <Status kind="track" pip="closed">Replaced by {replacement?.part_number ?? 'a newer number'}</Status> : part.status === 'OBSOLETE' ? <Status kind="track" pip="closed">Obsolete</Status> : <Status kind="ready" pip="ready">Active</Status>}
          {row.below && <Status kind="risk" pip="risk">Below minimum</Status>}
          {!part.is_active && <Tag>Hidden from the counter</Tag>}
        </div>
        {part.mfr_vendor_id && <p className="t-cap" style={{ marginTop: 8 }}>From {vendors[part.mfr_vendor_id] ?? 'the manufacturer'}</p>}
        {error && <div style={{ marginTop: 8 }}><Failure text={error} /></div>}
      </PanelSection>

      <PanelSection title="Prices">
        {readOnly ? (
          <p className="ops-facts"><span>Counter <b className="tnum">{part.price_cents == null ? '—' : money(part.price_cents)}</b></span><span>List <b className="tnum">{part.list_price_cents == null ? '—' : money(part.list_price_cents)}</b></span>{mv.cost && <span>Cost <b className="tnum">{part.cost_cents == null ? '—' : money(part.cost_cents)}</b></span>}</p>
        ) : (
          <div className="mp-form">
            <div className="mp-form-2">
              <Field label="Counter price"><MoneyInput valueCents={price} onChangeCents={setPrice} onBlur={() => { if (price !== part.price_cents) save({ priceCents: price }, 'Saved the counter price'); }} /></Field>
              <Field label="List price"><MoneyInput valueCents={list} onChangeCents={setList} onBlur={() => { if (list !== part.list_price_cents) save({ listPriceCents: list }, 'Saved the list price'); }} /></Field>
            </div>
            {mv.cost && <Field label="Cost" help="Updates itself from the last stock-order receipt"><MoneyInput valueCents={cost} onChangeCents={setCost} onBlur={() => { if (cost !== part.cost_cents) save({ costCents: cost }, 'Saved the cost'); }} /></Field>}
            {mv.cost && part.price_cents != null && part.cost_cents ? <p className="t-cap">Margin at counter price: {Math.round(((part.price_cents - part.cost_cents) / Math.max(part.price_cents, 1)) * 1000) / 10}%</p> : null}
          </div>
        )}
      </PanelSection>

      <PanelSection title="Stock locations">
        {stockLocations.length === 0 ? <p className="t-cap">No stock locations on this company yet. Add the parts room in Store settings.</p> : (
          <table className="dl-tbl">
            <thead><tr><th>Location</th><th>Bin</th><th className="n">On hand</th><th className="n">Min</th><th className="n">Max</th>{!readOnly && <th />}</tr></thead>
            <tbody>{stockLocations.map((s) => <StockingRow key={s.id} s={s} r={row.rows.find((x) => x.stock_location_id === s.id) ?? null} readOnly={readOnly} busy={busy === `stk:${s.id}`} onSave={(b) => void act(`stk:${s.id}`, 'post', url, { op: 'stocking', stockLocationId: s.id, ...b }, `Saved stocking at ${s.code}`)} />)}</tbody>
          </table>
        )}
        {row.rows.some((r) => r.qty_special_order_open > 0) && <p className="t-cap" style={{ marginTop: 8 }}>{count(row.rows.reduce((s, r) => Math.max(s, r.qty_special_order_open), 0))} on open special orders.</p>}
      </PanelSection>

      {!readOnly && part.status !== 'SUPERSEDED' && (
        <PanelSection title="Special order">
          <form className="mp-form" onSubmit={(e) => { e.preventDefault(); const q = parseNum(soQty); if (!q || q <= 0 || !soCustomer.id) return; void act('so', 'post', url, { op: 'special_order', qty: q, customerId: soCustomer.id }, `Special order for ${soCustomer.name}`); }}>
            <div className="mp-form-2">
              <Field label="Customer"><CustomerPicker value={soCustomer} onChange={setSoCustomer} companyId={part.location_id} /></Field>
              <Field label="Quantity"><Input inputMode="decimal" value={soQty} onChange={(e) => setSoQty(e.target.value)} /></Field>
            </div>
            <div><Button type="submit" disabled={busy === 'so' || !soCustomer.id}>Request special order</Button></div>
          </form>
        </PanelSection>
      )}

      {!readOnly && part.status === 'ACTIVE' && (
        <PanelSection title="Superseded by">
          <form className="row" style={{ gap: 8, alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); if (newPn.trim()) void act('sup', 'post', url, { op: 'supersede', newPartNumber: newPn.trim() }, `${part.part_number} now sells as ${newPn.trim().toUpperCase()}`); }}>
            <Field label="Replacement number" help="The counter sells the new number when this one is keyed"><Input value={newPn} onChange={(e) => setNewPn(e.target.value)} maxLength={40} autoCapitalize="characters" /></Field>
            <Button type="submit" disabled={busy === 'sup' || !newPn.trim()}>Supersede</Button>
          </form>
        </PanelSection>
      )}

      {!readOnly && (
        <PanelSection>
          <Button variant="quiet" disabled={busy === 'upd'} onClick={() => save({ isActive: !part.is_active }, part.is_active ? 'Hid the part from the counter' : 'Showed the part at the counter')}>{part.is_active ? 'Hide from the counter' : 'Show at the counter'}</Button>
        </PanelSection>
      )}
    </Panel>
  );
}

function StockingRow({ s, r, readOnly, busy, onSave }: { s: StockLocationRow; r: PartOnHandRow | null; readOnly: boolean; busy: boolean; onSave: (b: { bin: string | null; min: number; max: number | null }) => void }) {
  const [bin, setBin] = useState(r?.bin ?? '');
  const [min, setMin] = useState(r?.min_qty == null ? '' : String(r.min_qty));
  const [max, setMax] = useState(r?.max_qty == null ? '' : String(r.max_qty));
  const [err, setErr] = useState<string | null>(null);
  return (
    <tr>
      <td><span className="l1">{s.code}</span><span className="l2">{s.name}</span>{err && <span className="l2 neg">{err}</span>}</td>
      <td>{readOnly ? r?.bin ?? '—' : <Input aria-label={`Bin at ${s.code}`} value={bin} onChange={(e) => setBin(e.target.value)} maxLength={24} style={{ width: 80 }} />}</td>
      <td className="n"><span className={r?.below_min ? 'neg b' : undefined}>{count(r?.qty_on_hand ?? 0)}</span></td>
      <td className="n">{readOnly ? (r?.min_qty ?? '—') : <Input aria-label={`Minimum at ${s.code}`} inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} style={{ width: 60 }} />}</td>
      <td className="n">{readOnly ? (r?.max_qty ?? '—') : <Input aria-label={`Maximum at ${s.code}`} inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value)} style={{ width: 60 }} />}</td>
      {!readOnly && <td><Button disabled={busy} onClick={() => {
        const mn = parseNum(min || '0');
        const mx = max.trim() ? parseNum(max) : null;
        if (mn == null || mn < 0) return setErr('Min must be 0 or more.');
        if (max.trim() && (mx == null || mx < mn)) return setErr('Max must be at least min.');
        setErr(null);
        onSave({ bin: bin.trim() || null, min: mn, max: mx });
      }}>Save</Button></td>}
    </tr>
  );
}
