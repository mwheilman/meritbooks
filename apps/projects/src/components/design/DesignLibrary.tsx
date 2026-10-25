'use client';

import { useEffect, useState } from 'react';
import { Button, Check, Field, Figure, Input, QueueTable, Select, Status, money, type QueueColumn } from '@meritbooks/merit-ui';
import type { DesignProductRow } from '@/app/api/design/ops/route';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, PctInput, Section, parseNum } from '@/components/ops/common/bits';
import { BoardState, Empty, centsFrom, pctText, qty, useBoard, useDo } from '@/components/dealer/common/depth';

interface Rule { id: string; name: string; vendor_id: string | null; category: string | null; customer_id: string | null; method: 'COST_PLUS' | 'DISCOUNT_FROM_RETAIL' | 'TIERED'; pct: number | null; freight_pct: number | null; procurement_fee_pct: number | null; show_cost: boolean; priority: number; is_active: boolean }
interface Reports { product_margin: { sell_cents?: number; cost_cents?: number; realized_markup_pct?: number | null; target_markup_pct?: number | null }; fee_realization: { billed_cents: number; by_kind: Record<string, number> } | null;
  utilization: { hours: number; billed_hours: number; utilization: number | null } | null; deposits: { client_deposits_held_cents: number; vendor_deposits_open_cents: number } | null;
  items_by_status: Record<string, number>; unbilled: { freight_cents: number; open_reimbursables_cents: number; storage_open_cents: number } | null }
interface ClipDraft { name: string; vendor: string; sku: string; category: string; w: string; d: string; h: string; finish: string; lead: string; cost: string; retail: string; url: string; image: string }
const EMPTY: ClipDraft = { name: '', vendor: '', sku: '', category: '', w: '', d: '', h: '', finish: '', lead: '', cost: '', retail: '', url: '', image: '' };
const METHOD: Record<Rule['method'], string> = { COST_PLUS: 'Cost plus', DISCOUNT_FROM_RETAIL: 'Discount from retail', TIERED: 'Tiered' };
const https = (s: string) => s === '' || /^https:\/\/\S+$/.test(s);

/** The firm's product library (ID-07 clipper, ID-08 library), pricing rules and a price check (ID-14), and design reports (ID-36). */
export function DesignLibrary({ companyId, today }: { companyId: string; today: string }) {
  const { readOnly } = useShell();
  const url = '/api/design/ops';
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  useEffect(() => { const t = setTimeout(() => setDq(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const lib = useBoard<{ products: DesignProductRow[] }>(`${url}?company=${companyId}&view=library${dq ? `&q=${encodeURIComponent(dq)}` : ''}`);
  const rules = useBoard<{ rules: Rule[] }>(`${url}?company=${companyId}&view=rules`);
  const rep = useBoard<Reports>(`${url}?company=${companyId}&view=reports&from=${today.slice(0, 4)}-01-01&to=${today}`);
  const { run, busy, error } = useDo(() => { lib.reload(); rules.reload(); });
  const [c, setC] = useState<ClipDraft>(EMPTY);
  const [rule, setRule] = useState<{ name: string; method: Rule['method']; pct: number | null; category: string; freight: number | null; fee: number | null }>({ name: '', method: 'COST_PLUS', pct: 0.35, category: '', freight: null, fee: null });
  const [chk, setChk] = useState({ cost: '', retail: '', category: '' });
  const [priced, setPriced] = useState<{ client_unit_price_cents: number | null; rule: string | null; freight_cents: number | null; procurement_fee_cents: number | null } | null>(null);
  const cents = (s: string) => (s ? centsFrom(s) : null);
  const num = (s: string) => (s ? parseNum(s) : null);
  const clipBad = !c.name.trim() || (c.cost && cents(c.cost) == null) || (c.retail && cents(c.retail) == null) || !https(c.url) || !https(c.image) || [c.w, c.d, c.h, c.lead].some((x) => x && num(x) == null);
  const cols: QueueColumn<DesignProductRow>[] = [
    { id: 'n', header: 'Product', cell: (p) => <><span className="l1">{p.name}</span><span className="l2">{[p.vendor_name, p.sku, p.finish].filter(Boolean).join(' · ')}</span></> },
    { id: 'c', header: 'Category', width: 130, cell: (p) => p.category ?? '—' },
    { id: 'sz', header: 'W × D × H', width: 130, cell: (p) => (p.width_in ? `${qty(p.width_in)} × ${qty(p.depth_in)} × ${qty(p.height_in)}″` : '—') },
    { id: 'l', header: 'Lead', numeric: true, width: 80, cell: (p) => (p.lead_time_days == null ? '—' : `${p.lead_time_days} d`) },
    { id: 't', header: 'Trade', numeric: true, width: 110, cell: (p) => (p.trade_cost_cents == null ? '—' : money(p.trade_cost_cents)) },
    { id: 'r', header: 'Retail', numeric: true, width: 110, cell: (p) => (p.retail_cents == null ? '—' : money(p.retail_cents)) },
  ];
  const r = rep.data;
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      {r && <div className="dl-strip">
        <Figure dense label="Product markup" value={pctText(r.product_margin.realized_markup_pct ?? null, 0)} vs={[`target ${pctText(r.product_margin.target_markup_pct ?? null, 0)}`, r.product_margin.sell_cents != null ? `sold ${money(r.product_margin.sell_cents, { decimals: 0 })}` : 'year to date']} href="/design" linkLabel="Projects" />
        <Figure dense label="Fees billed" value={r.fee_realization ? money(r.fee_realization.billed_cents, { decimals: 0 }) : '—'} vs={['year to date', `${Object.keys(r.fee_realization?.by_kind ?? {}).length} fee kinds`]} href="/design" linkLabel="Projects" />
        <Figure dense label="Utilization" value={pctText(r.utilization?.utilization ?? null, 0)} vs={[`${qty(r.utilization?.billed_hours ?? 0)} billed h`, `of ${qty(r.utilization?.hours ?? 0)} h`]} href="/time" linkLabel="Time" />
        <Figure dense label="Client deposits held" value={r.deposits ? money(r.deposits.client_deposits_held_cents, { decimals: 0 }) : '—'} vs={[r.deposits ? `vendor deposits out ${money(r.deposits.vendor_deposits_open_cents, { decimals: 0 })}` : 'hidden', r.unbilled ? `unbilled freight ${money(r.unbilled.freight_cents, { decimals: 0 })}` : '']} href="/billing" linkLabel="Billing" />
      </div>}
      <Section title="Product library" meta="Clip once, specify on any project">
        <Field label="Search"><Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name" /></Field>
        <BoardState b={lib} what="Library" />
        {lib.data && (lib.data.products.length === 0 ? <Empty title={dq ? 'Nothing matches' : 'The library is empty'} body="Clip products from vendor sites (the browser clipper posts here) or add one below." /> :
          <div className="mp-table"><QueueTable aria-label="Products" columns={cols} rows={lib.data.products} getRowId={(p) => p.id} /></div>)}
      </Section>
      {!readOnly && (
        <Section title="Add a product">
          <div className="ops-toolbar">
            <Field label="Name"><Input value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} /></Field>
            <Field label="Vendor"><Input value={c.vendor} onChange={(e) => setC({ ...c, vendor: e.target.value })} /></Field>
            <Field label="SKU"><Input value={c.sku} style={{ width: 110 }} onChange={(e) => setC({ ...c, sku: e.target.value })} /></Field>
            <Field label="Category"><Input value={c.category} style={{ width: 120 }} onChange={(e) => setC({ ...c, category: e.target.value })} /></Field>
            <Field label="Finish"><Input value={c.finish} onChange={(e) => setC({ ...c, finish: e.target.value })} /></Field>
          </div>
          <div className="ops-toolbar">
            {(['w', 'd', 'h'] as const).map((k) => <Field key={k} label={k === 'w' ? 'Width (in)' : k === 'd' ? 'Depth (in)' : 'Height (in)'} error={c[k] && num(c[k]) == null ? 'Inches' : undefined}><Input value={c[k]} style={{ width: 80 }} onChange={(e) => setC({ ...c, [k]: e.target.value })} /></Field>)}
            <Field label="Lead (days)" error={c.lead && num(c.lead) == null ? 'Days' : undefined}><Input value={c.lead} style={{ width: 80 }} onChange={(e) => setC({ ...c, lead: e.target.value })} /></Field>
            <Field label="Trade cost" error={c.cost && cents(c.cost) == null ? 'Dollars' : undefined}><Input value={c.cost} style={{ width: 100 }} onChange={(e) => setC({ ...c, cost: e.target.value })} /></Field>
            <Field label="Retail" error={c.retail && cents(c.retail) == null ? 'Dollars' : undefined}><Input value={c.retail} style={{ width: 100 }} onChange={(e) => setC({ ...c, retail: e.target.value })} /></Field>
          </div>
          <div className="ops-toolbar">
            <Field label="Vendor page" error={https(c.url) ? undefined : 'An https:// link'}><Input value={c.url} onChange={(e) => setC({ ...c, url: e.target.value })} /></Field>
            <Field label="Image" error={https(c.image) ? undefined : 'An https:// link'}><Input value={c.image} onChange={(e) => setC({ ...c, image: e.target.value })} /></Field>
            <Button variant="primary" disabled={!!clipBad || busy === 'clip'} onClick={async () => {
              const x = await run('clip', url, { op: 'clip', companyId, clip: { name: c.name.trim(), vendor_name: c.vendor || null, sku: c.sku || null, category: c.category || null, finish: c.finish || null,
                width_in: num(c.w), depth_in: num(c.d), height_in: num(c.h), lead_time_days: c.lead ? Math.round(num(c.lead) ?? 0) : null, trade_cost_cents: cents(c.cost), retail_cents: cents(c.retail),
                vendor_url: c.url || null, image_url: c.image || null, source: 'CLIPPER' } }, 'Added to the library');
              if (x) setC(EMPTY);
            }}>Add to library</Button>
          </div>
        </Section>
      )}
      <Section title="Pricing rules" meta="Most specific wins: client, then vendor, then category, then the firm default">
        <BoardState b={rules} what="Pricing rules" />
        {rules.data && (rules.data.rules.length === 0 ? <p className="l2">No rules — the firm default markup applies.</p> :
          <table className="ops-mini" aria-label="Pricing rules"><thead><tr><th>Rule</th><th>Applies to</th><th>Method</th><th className="n">Pct</th><th>Active</th></tr></thead>
            <tbody>{rules.data.rules.map((x) => <tr key={x.id}><td>{x.name}</td><td>{x.customer_id ? 'a client' : x.vendor_id ? 'a vendor' : x.category ?? 'everything'}</td><td>{METHOD[x.method]}</td><td className="n">{pctText(x.pct, 0)}</td>
              <td>{readOnly ? (x.is_active ? 'Yes' : 'No') : <Check aria-label={`${x.name} active`} checked={x.is_active} onChange={(e) => run(`r${x.id}`, url, { op: 'rule', companyId, ruleId: x.id, fields: { is_active: e.target.checked } }, null)} />}</td></tr>)}</tbody></table>)}
        {!readOnly && <div className="ops-toolbar">
          <Field label="Name"><Input value={rule.name} onChange={(e) => setRule({ ...rule, name: e.target.value })} placeholder="Lighting at 40%" /></Field>
          <Field label="Method"><Select value={rule.method} onChange={(e) => setRule({ ...rule, method: e.target.value as Rule['method'] })}>{(['COST_PLUS', 'DISCOUNT_FROM_RETAIL'] as const).map((m) => <option key={m} value={m}>{METHOD[m]}</option>)}</Select></Field>
          <Field label={rule.method === 'COST_PLUS' ? 'Markup' : 'Discount'}><PctInput value={rule.pct} max={1000} aria-label="Percent" onChange={(v) => setRule({ ...rule, pct: v })} /></Field>
          <Field label="Category (blank = all)"><Input value={rule.category} style={{ width: 120 }} onChange={(e) => setRule({ ...rule, category: e.target.value })} /></Field>
          <Field label="Freight"><PctInput value={rule.freight} aria-label="Freight percent" onChange={(v) => setRule({ ...rule, freight: v })} /></Field>
          <Field label="Procurement fee"><PctInput value={rule.fee} aria-label="Procurement fee percent" onChange={(v) => setRule({ ...rule, fee: v })} /></Field>
          <Button disabled={!rule.name.trim() || rule.pct == null || busy === 'rule'} onClick={async () => {
            const x = await run('rule', url, { op: 'rule', companyId, fields: { name: rule.name.trim(), method: rule.method, pct: rule.pct, category: rule.category || null, freight_pct: rule.freight, procurement_fee_pct: rule.fee, priority: rule.category ? 50 : 100 } }, 'Rule added');
            if (x) setRule({ ...rule, name: '', category: '' });
          }}>Add rule</Button>
        </div>}
        <div className="ops-toolbar">
          <Field label="Check a price: trade cost" error={chk.cost && cents(chk.cost) == null ? 'Dollars' : undefined}><Input value={chk.cost} style={{ width: 100 }} onChange={(e) => { setChk({ ...chk, cost: e.target.value }); setPriced(null); }} /></Field>
          <Field label="Retail" error={chk.retail && cents(chk.retail) == null ? 'Dollars' : undefined}><Input value={chk.retail} style={{ width: 100 }} onChange={(e) => { setChk({ ...chk, retail: e.target.value }); setPriced(null); }} /></Field>
          <Field label="Category"><Input value={chk.category} style={{ width: 120 }} onChange={(e) => { setChk({ ...chk, category: e.target.value }); setPriced(null); }} /></Field>
          <Button disabled={(cents(chk.cost) == null && cents(chk.retail) == null) || busy === 'px'} onClick={async () => {
            const x = await run<{ client_unit_price_cents: number | null; rule: string | null; freight_cents: number | null; procurement_fee_cents: number | null }>('px', url, { op: 'price', companyId, costCents: cents(chk.cost), retailCents: cents(chk.retail), category: chk.category || null }, null);
            setPriced(x);
          }}>Price it</Button>
          {priced && <span className="l1">{priced.client_unit_price_cents == null ? 'No price' : money(priced.client_unit_price_cents)} <span className="l2">{priced.rule ?? 'firm default'}{priced.freight_cents ? ` · freight ${money(priced.freight_cents)}` : ''}{priced.procurement_fee_cents ? ` · fee ${money(priced.procurement_fee_cents)}` : ''}</span></span>}
        </div>
      </Section>
      {r && Object.keys(r.items_by_status).length > 0 && <Section title="Items by status">
        <span className="btn-row">{Object.entries(r.items_by_status).map(([k, n]) => <Status key={k} kind={k === 'CANCELLED' ? 'blocked' : k === 'INSTALLED' ? 'ready' : 'track'} pip="open">{k.toLowerCase().replace(/_/g, ' ')} {n}</Status>)}</span>
      </Section>}
    </div>
  );
}
