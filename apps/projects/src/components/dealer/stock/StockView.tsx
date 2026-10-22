'use client';

import { useMemo, useState } from 'react';
import {
  Button, Field, Figure, Keybar, QueueTable, Search, Seg, Select, Status, Tag, WidgetState, count, money, type QueueColumn,
} from '@meritbooks/merit-ui';
import { CONDITION_WORDS, UNIT_STATUS, agingMark, floorMark, unitTitle } from '@/lib/pm/dealer/labels';
import { isAged } from '@/lib/pm/dealer/math';
import type { DealerSettingsRow, StockLocationRow, UnitCondition, UnitInventoryRow, UnitStatus } from '@/lib/pm/dealer/types';
import { useShell } from '@/components/shell/ShellContext';
import { StatusMark } from '@/components/ops/common/bits';
import { PickStoreNote } from '../common/StoreOff';
import { ReceivePanel } from './ReceivePanel';
import { UnitPanel } from './UnitPanel';

export type StockGroup = 'all' | 'stock' | 'order' | 'held' | 'rental';
export type AgeFilter = 'all' | '90' | '180' | '365';

const GROUPS: Record<Exclude<StockGroup, 'all'>, ReadonlyArray<UnitStatus>> = {
  stock: ['IN_STOCK', 'PDI', 'DEMO'],
  order: ['ON_ORDER', 'IN_TRANSIT'],
  held: ['ON_HOLD', 'SOLD'],
  rental: ['RENTAL'],
};

export interface StockViewProps {
  units: UnitInventoryRow[];
  vendors: Record<string, string>;
  photoCounts: Record<string, number>;
  stockLocations: StockLocationRow[];
  companies: Array<{ id: string; name: string }>;
  settings: Record<string, DealerSettingsRow>;
  writeCompanyId: string | null;
  multi: boolean;
  today: string;
  capped: boolean;
  focusId: string | null;
  openReceive: boolean;
  initialGroup: StockGroup;
  initialAge: AgeFilter;
}

export function StockView(p: StockViewProps) {
  const { readOnly } = useShell();
  const [group, setGroup] = useState<StockGroup>(p.initialGroup);
  const [age, setAge] = useState<AgeFilter>(p.initialAge);
  const [cond, setCond] = useState<UnitCondition | ''>('');
  const [make, setMake] = useState('');
  const [category, setCategory] = useState('');
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState<string | null>(p.focusId);
  const [receiving, setReceiving] = useState(p.openReceive && !!p.writeCompanyId && !readOnly);
  const names = useMemo(() => Object.fromEntries(p.companies.map((c) => [c.id, c.name])), [p.companies]);

  const makes = useMemo(() => [...new Set(p.units.map((u) => u.make).filter((x): x is string => !!x))].sort(), [p.units]);
  const categories = useMemo(() => [...new Set(p.units.map((u) => u.category).filter((x): x is string => !!x))].sort(), [p.units]);

  const visible = useMemo(() => {
    const t = q.trim().toLowerCase();
    return p.units.filter((u) => {
      if (group !== 'all' && !GROUPS[group].includes(u.unit_status)) return false;
      if (cond && u.condition !== cond) return false;
      if (make && u.make !== make) return false;
      if (category && u.category !== category) return false;
      if (age !== 'all' && (u.days_in_stock ?? -1) <= Number(age)) return false;
      if (t && ![u.stock_number, u.serial_number, u.vin, u.make, u.model, u.category, u.deal_number].filter(Boolean).join(' ').toLowerCase().includes(t)) return false;
      return true;
    });
  }, [p.units, group, cond, make, category, age, q]);

  const inStock = p.units.filter((u) => ['IN_STOCK', 'PDI', 'DEMO', 'ON_HOLD'].includes(u.unit_status));
  const aged = p.units.filter(isAged);
  const floored = p.units.filter((u) => u.floored);
  const attention = p.units.filter((u) => floorMark(u, p.today).attention);
  const sum = (xs: UnitInventoryRow[], f: (u: UnitInventoryRow) => number) => xs.reduce((s, u) => s + f(u), 0);
  const cursorUnit = p.units.find((u) => u.unit_id === cursor) ?? null;

  const columns: QueueColumn<UnitInventoryRow>[] = [
    { id: 'stk', header: 'Stock #', width: 120, cell: (u) => <><span className="l1 code">{u.stock_number ?? '—'}</span><span className="l2">{u.condition ? CONDITION_WORDS[u.condition] : ''}{u.is_sample ? ' · sample' : ''}</span></> },
    {
      id: 'unit',
      header: 'Unit',
      cell: (u) => (
        <>
          <span className="l1">{unitTitle(u)}</span>
          <span className="l2">{[u.serial_number ? `S/N ${u.serial_number}` : null, u.stock_location_code, p.multi ? names[u.location_id] : null, p.photoCounts[u.unit_id] ? `${p.photoCounts[u.unit_id]} photo${p.photoCounts[u.unit_id] === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ') || ' '}</span>
        </>
      ),
    },
    { id: 'st', header: 'Status', width: 190, cell: (u) => <><StatusMark mark={UNIT_STATUS[u.unit_status]} />{u.deal_number && <span className="l2">Deal {u.deal_number}</span>}</> },
    { id: 'age', header: 'In stock', width: 104, cell: (u) => { const m = agingMark(u.days_in_stock); return m ? <Status kind={m.kind} pip={m.pip}>{m.word}</Status> : <span className="l2">Not received</span>; } },
    {
      id: 'cost', header: 'Cost', numeric: true, width: 124,
      cell: (u) => <><span className="l1 tnum">{money(u.cost_cents)}</span>{u.books_cost_cents != null && u.books_cost_cents !== u.cost_cents ? <span className="l2 tnum">Books {money(u.books_cost_cents)}</span> : null}</>,
    },
    { id: 'price', header: 'Price', numeric: true, width: 116, cell: (u) => { const pr = u.advertised_price_cents ?? u.retail_price_cents; return pr == null ? '—' : money(pr); } },
    { id: 'floor', header: 'Floor plan', width: 180, cell: (u) => { const f = floorMark(u, p.today); return <Status kind={f.kind} pip={f.pip}>{f.word}</Status>; } },
  ];

  const panel = receiving || !!cursor;

  return (
    <div className="stack">
      <div className="dl-strip">
        <Figure dense label="In stock" value={count(inStock.length)} vs={[`${money(sum(inStock, (u) => u.cost_cents), { decimals: 0 })} at cost`, `${count(p.units.filter((u) => GROUPS.order.includes(u.unit_status)).length)} on order`]} href="/stock?group=stock" linkLabel="In stock" />
        <Figure dense label="Aged over 180 days" value={count(aged.length)} vs={[`${money(sum(aged, (u) => u.cost_cents), { decimals: 0 })} tied up`, inStock.length ? `${Math.round((aged.length / inStock.length) * 100)}% of stock` : 'no stock yet']} href="/stock?age=180" linkLabel="Aged units" />
        <Figure dense label="Floored" value={count(floored.length)} vs={[`${money(sum(floored, (u) => u.payoff_cents ?? 0), { decimals: 0 })} payoff`, attention.length ? `${count(attention.length)} need a payoff` : 'none past due']} href="/stock?group=all" linkLabel="Floor plan" />
      </div>

      <div className="dl-filters">
        <Seg<StockGroup> aria-label="Show" value={group} onChange={setGroup} items={[
          { value: 'all', label: 'All', count: p.units.length },
          { value: 'stock', label: 'In stock', count: p.units.filter((u) => GROUPS.stock.includes(u.unit_status)).length },
          { value: 'order', label: 'On order', count: p.units.filter((u) => GROUPS.order.includes(u.unit_status)).length },
          { value: 'held', label: 'Held or sold', count: p.units.filter((u) => GROUPS.held.includes(u.unit_status)).length },
          { value: 'rental', label: 'Rental', count: p.units.filter((u) => u.unit_status === 'RENTAL').length },
        ]} />
        <Field label="Condition">
          <Select value={cond} onChange={(e) => setCond(e.target.value as UnitCondition | '')}>
            <option value="">Any</option>
            {(Object.keys(CONDITION_WORDS) as UnitCondition[]).map((c) => <option key={c} value={c}>{CONDITION_WORDS[c]}</option>)}
          </Select>
        </Field>
        <Field label="Make">
          <Select value={make} onChange={(e) => setMake(e.target.value)}>
            <option value="">Any</option>
            {makes.map((m) => <option key={m} value={m}>{m}</option>)}
          </Select>
        </Field>
        <Field label="Category">
          <Select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">Any</option>
            {categories.map((c) => <option key={c} value={c}>{c.replace(/_/g, ' ').toLowerCase()}</option>)}
          </Select>
        </Field>
        <Field label="Age">
          <Select value={age} onChange={(e) => setAge(e.target.value as AgeFilter)}>
            <option value="all">Any age</option>
            <option value="90">Over 90 days</option>
            <option value="180">Over 180 days</option>
            <option value="365">Over a year</option>
          </Select>
        </Field>
        <div style={{ width: 240 }}><Search aria-label="Find a unit" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Stock #, serial, VIN, model" slashToFocus /></div>
        <span className="sp" />
        {!readOnly && p.writeCompanyId && (
          <Button variant="primary" icon="plus" chord="n" bindChord={!receiving} onClick={() => { setReceiving(true); setCursor(null); }}>Receive a unit</Button>
        )}
      </div>
      {!readOnly && !p.writeCompanyId && <PickStoreNote what="Units" />}

      <div className={panel ? 'ops-split has-panel' : 'ops-split'}>
        <div className="mp-table" style={{ minWidth: 0 }}>
          {visible.length === 0 ? (
            <WidgetState
              state={p.units.length === 0
                ? { kind: 'empty', title: 'No units in stock yet', body: 'Receive a unit against its manufacturer invoice: serial, model and cost. Merit Books books the cost and proposes flooring when Books is on.', action: readOnly || !p.writeCompanyId ? undefined : <Button variant="primary" onClick={() => setReceiving(true)}>Receive a unit</Button> }
                : { kind: 'done', title: q ? `Nothing matches “${q}”` : 'Nothing in this view', body: 'Clear a filter above to see the rest of the lot.' }}
            />
          ) : (
            <QueueTable
              aria-label="Units"
              columns={columns}
              rows={visible}
              getRowId={(u) => u.unit_id}
              cursorId={cursor}
              onCursorChange={(id) => { setCursor(id); setReceiving(false); }}
              onOpen={(u) => { setCursor(u.unit_id); setReceiving(false); }}
              rowState={(u) => ({ attn: floorMark(u, p.today).attention || (u.days_in_stock ?? 0) > 180 })}
            />
          )}
          {p.capped && <p className="t-cap" style={{ padding: 12 }}>Showing the oldest 1,000 units. Filter or search to narrow it.</p>}
        </div>
        {receiving && p.writeCompanyId ? (
          <ReceivePanel
            companyId={p.writeCompanyId}
            stockLocations={p.stockLocations.filter((s) => s.location_id === p.writeCompanyId && s.is_active)}
            defaultStockLocationId={p.settings[p.writeCompanyId]?.unit_stock_location_id ?? null}
            onOrder={p.units.filter((u) => u.location_id === p.writeCompanyId && (u.unit_status === 'ON_ORDER' || u.unit_status === 'IN_TRANSIT'))}
            today={p.today}
            onClose={() => setReceiving(false)}
            onDone={(id) => { setReceiving(false); setCursor(id); }}
          />
        ) : cursor ? (
          <UnitPanel
            key={cursor}
            id={cursor}
            today={p.today}
            stockLocations={p.stockLocations.filter((s) => s.is_active)}
            companyNames={names}
            onClose={() => setCursor(null)}
          />
        ) : null}
      </div>
      {visible.length > 0 && (
        <Keybar hints={[{ chord: 'j k', label: 'move' }, { chord: 'enter', label: 'open' }, { chord: '/', label: 'find' }, ...(readOnly || !p.writeCompanyId ? [] : [{ chord: 'n', label: 'receive a unit' }])]} note={cursorUnit?.sold_out_of_trust ? 'This unit is sold out of trust in Merit Books' : 'Cost is operational; Merit Books owns the ledger basis and the floor plan'} />
      )}
      {p.units.some((u) => u.is_sample) && <p className="t-cap"><Tag>Sample</Tag> units are practice records; nothing about them reaches Merit Books.</p>}
    </div>
  );
}
