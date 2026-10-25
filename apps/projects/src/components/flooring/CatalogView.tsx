'use client';

import { useState } from 'react';
import { Button, Field, Input, Select, money } from '@meritbooks/merit-ui';
import { FLOOR_CATEGORIES } from '@/lib/flooring/measure-import';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, Section } from '@/components/ops/common/bits';
import { BoardState, centsFrom, pctText, qty, useBoard, useDo } from '@/components/dealer/common/depth';

interface Product { id: string; sku: string | null; style: string; color: string | null; category: string; sell_uom: string; roll_width_ft: number | null; carton_sf: number | null; waste_pct: number | null; cost_cents: number | null; price_retail_cents: number | null; price_builder_cents: number | null; is_active: boolean }
interface Labor { id: string; code: string; description: string; unit: string; applies_to: string; sell_cents: number; pay_cents: number | null; job_minimum_pay_cents: number | null; is_active: boolean }
interface Cap { id: string; crew_id: string | null; weekday: number | null; on_date: string | null; sf_per_day: number; jobs_per_day: number | null }

const WEEKDAY = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Products with their sell unit, roll width or carton size and waste; labor codes with sell and installer pay; crew capacity in SF a day. */
export function CatalogView({ companyId, crews }: { companyId: string; crews: Array<{ id: string; name: string }> }) {
  const { readOnly } = useShell();
  const b = useBoard<{ products: Product[]; labor: Labor[]; capacity: Cap[] }>(`/api/flooring/catalog?company=${companyId}`);
  const { run, busy, error } = useDo(b.reload);
  const [p, setP] = useState({ style: '', color: '', sku: '', category: 'CARPET', uom: 'SY', width: '12', carton: '', waste: '10', cost: '', retail: '', builder: '' });
  const [l, setL] = useState({ code: '', description: '', unit: 'SY', applies: 'FLOOR', sell: '', pay: '', min: '' });
  const [c, setC] = useState({ crew: '', weekday: '', sf: '', jobs: '' });
  const state = <BoardState b={b} what="The catalog" />;
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      {state}
      {b.data && (
        <>
          <Section title="Products" meta={`${b.data.products.filter((x) => x.is_active).length} active`}>
            <table className="ops-mini" aria-label="Products">
              <thead><tr><th>Product</th><th>Category</th><th>Sold by</th><th className="n">Waste</th><th className="n">Cost</th><th className="n">Retail</th><th className="n">Builder</th><th /></tr></thead>
              <tbody>{b.data.products.map((x) => (
                <tr key={x.id} className={x.is_active ? undefined : 'void'}><td>{x.style}{x.color ? ` · ${x.color}` : ''}<div className="t-cap">{x.sku ?? ''}</div></td><td>{x.category.toLowerCase().replace(/_/g, ' ')}</td>
                  <td>{x.sell_uom}{x.roll_width_ft ? ` · ${qty(x.roll_width_ft)}′ roll` : ''}{x.carton_sf ? ` · ${qty(x.carton_sf)} SF/carton` : ''}</td><td className="n">{pctText(x.waste_pct, 0)}</td>
                  <td className="n">{x.cost_cents == null ? '—' : money(x.cost_cents)}</td><td className="n">{x.price_retail_cents == null ? '—' : money(x.price_retail_cents)}</td><td className="n">{x.price_builder_cents == null ? '—' : money(x.price_builder_cents)}</td>
                  <td>{!readOnly && x.is_active && <Button variant="quiet" disabled={busy === x.id} onClick={() => void run(x.id, '/api/flooring/catalog', { op: 'retire', kind: 'product', id: x.id }, 'Retired the product')}>Retire</Button>}</td></tr>
              ))}</tbody>
            </table>
            {!readOnly && (
              <div className="ops-toolbar" style={{ marginTop: 8 }}>
                <Field label="Style"><Input value={p.style} onChange={(e) => setP({ ...p, style: e.target.value })} style={{ width: 160 }} /></Field>
                <Field label="Color"><Input value={p.color} onChange={(e) => setP({ ...p, color: e.target.value })} style={{ width: 110 }} /></Field>
                <Field label="SKU"><Input value={p.sku} onChange={(e) => setP({ ...p, sku: e.target.value })} style={{ width: 100 }} /></Field>
                <Field label="Category"><Select value={p.category} onChange={(e) => setP({ ...p, category: e.target.value })}>{FLOOR_CATEGORIES.map((k) => <option key={k} value={k}>{k.toLowerCase().replace(/_/g, ' ')}</option>)}</Select></Field>
                <Field label="Sold by"><Select value={p.uom} onChange={(e) => setP({ ...p, uom: e.target.value })}>{['SY', 'SF', 'CARTON', 'LF', 'EA', 'ROLL'].map((k) => <option key={k} value={k}>{k}</option>)}</Select></Field>
                {(p.uom === 'SY' || p.uom === 'ROLL') && <Field label="Roll width (ft)"><Input inputMode="decimal" value={p.width} onChange={(e) => setP({ ...p, width: e.target.value })} style={{ width: 70 }} /></Field>}
                {p.uom === 'CARTON' && <Field label="SF per carton"><Input inputMode="decimal" value={p.carton} onChange={(e) => setP({ ...p, carton: e.target.value })} style={{ width: 80 }} /></Field>}
                <Field label="Waste %"><Input inputMode="decimal" value={p.waste} onChange={(e) => setP({ ...p, waste: e.target.value })} style={{ width: 60 }} /></Field>
                <Field label="Cost"><Input inputMode="decimal" value={p.cost} onChange={(e) => setP({ ...p, cost: e.target.value })} style={{ width: 80 }} /></Field>
                <Field label="Retail"><Input inputMode="decimal" value={p.retail} onChange={(e) => setP({ ...p, retail: e.target.value })} style={{ width: 80 }} /></Field>
                <Field label="Builder"><Input inputMode="decimal" value={p.builder} onChange={(e) => setP({ ...p, builder: e.target.value })} style={{ width: 80 }} /></Field>
                <Button variant="primary" disabled={!p.style.trim() || busy === 'p'} onClick={async () => {
                  const product = { style: p.style.trim(), color: p.color || null, sku: p.sku || null, category: p.category, sellUom: p.uom, rollWidthFt: (p.uom === 'SY' || p.uom === 'ROLL') && Number(p.width) > 0 ? Number(p.width) : null, cartonSf: p.uom === 'CARTON' && Number(p.carton) > 0 ? Number(p.carton) : null, wastePct: p.waste.trim() ? Number(p.waste) / 100 : null, costCents: centsFrom(p.cost), priceRetailCents: centsFrom(p.retail), priceBuilderCents: centsFrom(p.builder) };
                  if (await run('p', '/api/flooring/catalog', { op: 'add_product', companyId, product }, 'Added the product')) setP({ ...p, style: '', color: '', sku: '', cost: '', retail: '', builder: '' });
                }}>Add product</Button>
              </div>
            )}
          </Section>
          <Section title="Labor codes" meta="Sell price to the customer and piece rate to the installer">
            <table className="ops-mini" aria-label="Labor codes">
              <thead><tr><th>Code</th><th>Labor</th><th>Unit</th><th>For</th><th className="n">Sell</th><th className="n">Installer pay</th><th className="n">Job minimum</th></tr></thead>
              <tbody>{b.data.labor.map((x) => <tr key={x.id} className={x.is_active ? undefined : 'void'}><td className="code">{x.code}</td><td>{x.description}</td><td>{x.unit}</td><td>{x.applies_to.toLowerCase()}</td><td className="n">{money(x.sell_cents)}</td><td className="n">{x.pay_cents == null ? '—' : money(x.pay_cents)}</td><td className="n">{x.job_minimum_pay_cents == null ? '—' : money(x.job_minimum_pay_cents)}</td></tr>)}</tbody>
            </table>
            {!readOnly && (
              <div className="ops-toolbar" style={{ marginTop: 8 }}>
                <Field label="Code"><Input value={l.code} onChange={(e) => setL({ ...l, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') })} style={{ width: 120 }} /></Field>
                <Field label="Labor"><Input value={l.description} onChange={(e) => setL({ ...l, description: e.target.value })} style={{ width: 200 }} /></Field>
                <Field label="Unit"><Select value={l.unit} onChange={(e) => setL({ ...l, unit: e.target.value })}>{['SY', 'SF', 'LF', 'STEP', 'EA', 'JOB', 'HOUR'].map((k) => <option key={k} value={k}>{k}</option>)}</Select></Field>
                <Field label="For"><Select value={l.applies} onChange={(e) => setL({ ...l, applies: e.target.value })}>{['FLOOR', 'STAIRS', 'PERIMETER', 'TRANSITION', 'PREP', 'DEMO', 'MOVING', 'OTHER'].map((k) => <option key={k} value={k}>{k.toLowerCase()}</option>)}</Select></Field>
                <Field label="Sell"><Input inputMode="decimal" value={l.sell} onChange={(e) => setL({ ...l, sell: e.target.value })} style={{ width: 80 }} /></Field>
                <Field label="Pay"><Input inputMode="decimal" value={l.pay} onChange={(e) => setL({ ...l, pay: e.target.value })} style={{ width: 80 }} /></Field>
                <Field label="Job minimum"><Input inputMode="decimal" value={l.min} onChange={(e) => setL({ ...l, min: e.target.value })} style={{ width: 90 }} /></Field>
                <Button disabled={l.code.length < 2 || !l.description.trim() || centsFrom(l.sell) == null || centsFrom(l.pay) == null || busy === 'l'} onClick={async () => {
                  if (await run('l', '/api/flooring/catalog', { op: 'add_labor', companyId, labor: { code: l.code, description: l.description.trim(), unit: l.unit, appliesTo: l.applies, sellCents: centsFrom(l.sell), payCents: centsFrom(l.pay), jobMinimumPayCents: centsFrom(l.min) ?? 0 } }, 'Added the labor code')) setL({ ...l, code: '', description: '', sell: '', pay: '', min: '' });
                }}>Add labor code</Button>
              </div>
            )}
          </Section>
          <Section title="Install capacity" meta="Square feet a crew lays in a day">
            <table className="ops-mini" aria-label="Capacity">
              <thead><tr><th>Crew</th><th>When</th><th className="n">SF a day</th><th className="n">Jobs a day</th></tr></thead>
              <tbody>{b.data.capacity.map((x) => <tr key={x.id}><td>{crews.find((k) => k.id === x.crew_id)?.name ?? 'All crews'}</td><td>{x.on_date ?? (x.weekday ? WEEKDAY[x.weekday] : 'Every day')}</td><td className="n">{qty(x.sf_per_day)}</td><td className="n">{x.jobs_per_day ?? '—'}</td></tr>)}</tbody>
            </table>
            {!readOnly && (
              <div className="ops-toolbar" style={{ marginTop: 8 }}>
                <Field label="Crew"><Select value={c.crew} onChange={(e) => setC({ ...c, crew: e.target.value })}><option value="">All crews</option>{crews.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}</Select></Field>
                <Field label="Day"><Select value={c.weekday} onChange={(e) => setC({ ...c, weekday: e.target.value })}><option value="">Every day</option>{WEEKDAY.slice(1).map((w, i) => <option key={w} value={String(i + 1)}>{w}</option>)}</Select></Field>
                <Field label="SF a day"><Input inputMode="decimal" value={c.sf} onChange={(e) => setC({ ...c, sf: e.target.value })} style={{ width: 90 }} /></Field>
                <Field label="Jobs a day"><Input inputMode="numeric" value={c.jobs} onChange={(e) => setC({ ...c, jobs: e.target.value })} style={{ width: 70 }} /></Field>
                <Button disabled={!(Number(c.sf) >= 0) || !c.sf.trim() || busy === 'c'} onClick={() => void run('c', '/api/flooring/catalog', { op: 'set_capacity', companyId, capacity: { crewId: c.crew || null, weekday: c.weekday ? Number(c.weekday) : null, sfPerDay: Number(c.sf), jobsPerDay: c.jobs.trim() ? Number(c.jobs) : null } }, 'Saved the capacity')}>Save capacity</Button>
              </div>
            )}
          </Section>
        </>
      )}
    </div>
  );
}
