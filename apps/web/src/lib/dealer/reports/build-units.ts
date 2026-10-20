/**
 * R3 Unit aging and R4 Unit gross (deal profitability) — pure builders.
 */

import { bucketsFromEdges } from '@/lib/dealer/engine/summary';
import { diffDays } from '@/lib/dealer/dates';
import type { DeptRole } from '@/lib/dealer/types';
import { DEPT_ROLE, UNIT_CONDITION, UNIT_STATUS } from '@/lib/dealer/ui/labels';
import { dealerLinks } from '@/lib/dealer/ui/links';
import type { DealerReport, DealerReportColumn, DealerReportRow } from './catalog';
import { centsLabel, makeReport } from './build-floor-plan';
import { ratioBps, row, spacer } from './model';

// ── R3 ────────────────────────────────────────────────────────────────────────

export interface AgingUnitRow {
  unit_id: string;
  serial_number: string;
  stock_number: string | null;
  make_vendor_id: string | null;
  model: string | null;
  model_year: number | null;
  condition: string;
  status: string;
  is_consignment: boolean;
  cost_cents: number;
  received_date: string | null;
  principal_balance_cents: number | null;
  maturity_date: string | null;
  is_floored: boolean;
}

export interface UnitAgingInput {
  asOf: string;
  entityLabel: string;
  edges: number[];
  units: AgingUnitRow[];
  makeNames: Map<string, string>;
}

export function unitAgingColumns(edges: number[]): DealerReportColumn[] {
  return [
    { key: 'units', label: 'Units', kind: 'count' },
    { key: 'cost', label: 'Cost', kind: 'money' },
    ...bucketsFromEdges(edges).map((b, i) => ({ key: `b${i}`, label: b.maxDays == null ? `${b.minDays}+ days` : `${b.minDays}–${b.maxDays} days`, kind: 'money' as const })),
    { key: 'undated', label: 'Not yet received', kind: 'money' },
    { key: 'floored', label: 'Floored cost', kind: 'money' },
    { key: 'owned', label: 'Owned cost', kind: 'money' },
    { key: 'fpBalance', label: 'Floor-plan balance', kind: 'money' },
    { key: 'term', label: 'Days to term end', kind: 'days' },
  ];
}

const CONDITION_ORDER = ['NEW', 'USED', 'DEMO', 'RENTAL'];

export function buildUnitAging(input: UnitAgingInput): DealerReport {
  const cols = unitAgingColumns(input.edges);
  const buckets = bucketsFromEdges(input.edges);
  const excludedConsignment = input.units.filter((u) => u.is_consignment).length;
  const future = input.units.filter((u) => !u.is_consignment && u.received_date && u.received_date > input.asOf).length;
  const units = input.units.filter((u) => !u.is_consignment && !(u.received_date && u.received_date > input.asOf));

  const makeOf = (u: AgingUnitRow) => (u.make_vendor_id ? input.makeNames.get(u.make_vendor_id) ?? 'Manufacturer' : '');
  const valuesFor = (u: AgingUnitRow): Record<string, number | null> => {
    const v: Record<string, number | null> = { units: 1, cost: u.cost_cents, floored: u.is_floored ? u.cost_cents : 0, owned: u.is_floored ? 0 : u.cost_cents };
    v.fpBalance = u.principal_balance_cents ?? 0;
    v.term = u.maturity_date ? diffDays(input.asOf, u.maturity_date) : null;
    if (!u.received_date) v.undated = u.cost_cents;
    else {
      const days = Math.max(0, diffDays(u.received_date, input.asOf));
      const i = buckets.findIndex((b) => days >= b.minDays && (b.maxDays == null || days <= b.maxDays));
      v[`b${i < 0 ? buckets.length - 1 : i}`] = u.cost_cents;
    }
    return v;
  };
  const addInto = (acc: Record<string, number | null>, v: Record<string, number | null>) => {
    for (const c of cols) {
      const x = v[c.key];
      if (x == null) continue;
      if (c.key === 'term') acc.term = acc.term == null ? x : Math.min(acc.term, x);
      else acc[c.key] = (acc[c.key] ?? 0) + x;
    }
  };

  const rows: DealerReportRow[] = [];
  const grand: Record<string, number | null> = {};
  const conditions = [...new Set(units.map((u) => u.condition))].sort((a, b) => CONDITION_ORDER.indexOf(a) - CONDITION_ORDER.indexOf(b));
  for (const cond of conditions) {
    const label = UNIT_CONDITION[cond as keyof typeof UNIT_CONDITION]?.label ?? cond;
    rows.push(row('section', label, cols, {}));
    const sub: Record<string, number | null> = {};
    const list = units
      .filter((u) => u.condition === cond)
      .sort((a, b) => makeOf(a).localeCompare(makeOf(b)) || (a.model ?? '').localeCompare(b.model ?? '') || (a.received_date ?? '').localeCompare(b.received_date ?? ''));
    for (const u of list) {
      const flags = [
        u.condition === 'DEMO' ? 'demo' : null,
        u.status === 'RENTAL' || u.condition === 'RENTAL' ? 'rental' : null,
        u.status === 'ON_ORDER' || u.status === 'IN_TRANSIT' ? UNIT_STATUS[u.status as 'ON_ORDER' | 'IN_TRANSIT'].label.toLowerCase() : null,
      ].filter(Boolean);
      const desc = [makeOf(u), u.model_year ? String(u.model_year) : '', u.model ?? ''].filter(Boolean).join(' ');
      const label = `Serial ${u.serial_number}${desc ? ` · ${desc}` : ''}${flags.length ? ` · ${flags.join(', ')}` : ''}`;
      const v = valuesFor(u);
      rows.push(row('account', label, cols, v, { indent: 1, code: u.stock_number ?? undefined, href: dealerLinks.unit(u.unit_id) }));
      addInto(sub, v);
    }
    rows.push(row('subtotal', `Total ${label.toLowerCase()}`, cols, sub));
    addInto(grand, sub);
  }
  if (rows.length) {
    rows.push(spacer(cols));
    rows.push(row('total', 'Total units in stock', cols, grand));
  }
  const notes = [
    'Days in stock run from the received date to the as-of date; unit status and floor-plan balances are current.',
    'Floored cost is the cost of units carried on a live floor-plan note; owned cost is everything else. Days to term end is the note’s maturity less the as-of date (negative = past term).',
  ];
  if (excludedConsignment) notes.push(`${excludedConsignment} consignment unit${excludedConsignment === 1 ? ' is' : 's are'} not dealer inventory and ${excludedConsignment === 1 ? 'is' : 'are'} excluded.`);
  if (future) notes.push(`${future} unit${future === 1 ? '' : 's'} received after the as-of date ${future === 1 ? 'is' : 'are'} excluded.`);
  return makeReport('dealer_unit_aging', input.entityLabel, { asOf: input.asOf }, cols, rows, notes);
}

// ── R4 ────────────────────────────────────────────────────────────────────────

export interface GrossSaleIn {
  id: string;
  unit_id: string;
  sale_date: string;
  sale_price_cents: number;
  cogs_cents: number | null;
  salesperson: string | null;
  trade_in_id: string | null;
  gl_entry_id: string | null;
  external_deal_ref: string | null;
}

export interface GrossInput {
  start: string;
  end: string;
  entityLabel: string;
  sales: GrossSaleIn[];
  units: Map<string, { serial_number: string; make_vendor_id: string | null; department_role: DeptRole; model: string | null }>;
  makeNames: Map<string, string>;
  overAllowance: Map<string, number>;
  /** COST_REDUCTION incentives on the unit / sale not already inside unit cost. */
  incentives: Array<{ unit_id: string | null; sale_id: string | null; amount_cents: number }>;
}

export const GROSS_COLUMNS: DealerReportColumn[] = [
  { key: 'price', label: 'Sale price', kind: 'money' },
  { key: 'cost', label: 'Unit cost', kind: 'money' },
  { key: 'over', label: 'Trade over-allowance', kind: 'money' },
  { key: 'incentives', label: 'Cost-reduction incentives', kind: 'money' },
  { key: 'gross', label: 'Gross', kind: 'money' },
  { key: 'grossPct', label: 'Gross %', kind: 'percent' },
];

export interface DealGross {
  price: number;
  cost: number;
  over: number;
  incentives: number;
  gross: number;
}

/** price − unit cost − over-allowance + cost-reduction incentives. */
export function dealGross(d: Omit<DealGross, 'gross'>): DealGross {
  return { ...d, gross: d.price - d.cost - d.over + d.incentives };
}

function grossValues(g: DealGross) {
  return { price: g.price, cost: g.cost, over: g.over, incentives: g.incentives, gross: g.gross, grossPct: ratioBps(g.gross, g.price) };
}

const addG = (a: DealGross, b: DealGross): DealGross => ({ price: a.price + b.price, cost: a.cost + b.cost, over: a.over + b.over, incentives: a.incentives + b.incentives, gross: a.gross + b.gross });
const zeroG = (): DealGross => ({ price: 0, cost: 0, over: 0, incentives: 0, gross: 0 });

export function buildUnitGross(input: GrossInput): DealerReport {
  const cols = GROSS_COLUMNS;
  const incBySale = new Map<string, number>();
  const incByUnit = new Map<string, number>();
  for (const i of input.incentives) {
    if (i.sale_id) incBySale.set(i.sale_id, (incBySale.get(i.sale_id) ?? 0) + i.amount_cents);
    else if (i.unit_id) incByUnit.set(i.unit_id, (incByUnit.get(i.unit_id) ?? 0) + i.amount_cents);
  }
  let missingCost = 0;
  const deals = input.sales.map((s) => {
    const unit = input.units.get(s.unit_id);
    if (s.cogs_cents == null) missingCost += 1;
    const g = dealGross({
      price: s.sale_price_cents,
      cost: s.cogs_cents ?? 0,
      over: s.trade_in_id ? input.overAllowance.get(s.trade_in_id) ?? 0 : 0,
      incentives: (incBySale.get(s.id) ?? 0) + (incByUnit.get(s.unit_id) ?? 0),
    });
    const make = unit?.make_vendor_id ? input.makeNames.get(unit.make_vendor_id) ?? 'Manufacturer' : 'Manufacturer not recorded';
    return { s, unit, g, make, person: s.salesperson?.trim() || 'No salesperson recorded', dept: unit?.department_role ?? 'WG_NEW' };
  });

  const rows: DealerReportRow[] = [];
  const total = deals.reduce((a, d) => addG(a, d.g), zeroG());
  if (deals.length) {
    rows.push(row('section', 'By salesperson', cols, {}));
    const people = [...new Set(deals.map((d) => d.person))].sort();
    for (const p of people) {
      rows.push(row('section', p, cols, {}, { indent: 1 }));
      let sub = zeroG();
      for (const d of deals.filter((x) => x.person === p).sort((a, b) => a.s.sale_date.localeCompare(b.s.sale_date))) {
        const ref = d.s.external_deal_ref ? ` · deal ${d.s.external_deal_ref}` : '';
        rows.push(
          row('account', `Serial ${d.unit?.serial_number ?? '—'}${d.unit?.model ? ` · ${d.unit.model}` : ''}${ref}`, cols, grossValues(d.g), {
            indent: 2,
            code: d.s.sale_date,
            href: dealerLinks.deal(d.s.id),
            ...(d.s.gl_entry_id ? { jeHref: dealerLinks.journalEntry(d.s.gl_entry_id) } : {}),
            ...(d.s.cogs_cents == null ? { tone: 'warning' as const } : {}),
          }),
        );
        sub = addG(sub, d.g);
      }
      rows.push(row('subtotal', `${p} total`, cols, grossValues(sub), { indent: 1 }));
    }
    const summary = (title: string, keyOf: (d: (typeof deals)[number]) => string) => {
      rows.push(spacer(cols));
      rows.push(row('section', title, cols, {}));
      const groups = new Map<string, DealGross>();
      for (const d of deals) groups.set(keyOf(d), addG(groups.get(keyOf(d)) ?? zeroG(), d.g));
      for (const [k, g] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) rows.push(row('account', k, cols, grossValues(g), { indent: 1 }));
    };
    summary('By make', (d) => d.make);
    summary('By department', (d) => DEPT_ROLE[d.dept]?.label ?? 'Department');
    rows.push(spacer(cols));
    rows.push(row('total', `Total (${deals.length} unit${deals.length === 1 ? '' : 's'} sold)`, cols, grossValues(total)));
  }
  const notes = [
    'Gross = sale price − unit cost (the posted cost of sale) − trade over-allowance + manufacturer cost-reduction incentives on the unit or deal that were not already taken off the unit’s cost.',
    'Only posted sales dated in the period are included. The "By make" and "By department" views re-group the same deals, so each foots to the total.',
  ];
  if (missingCost) notes.push(`${missingCost} sale${missingCost === 1 ? ' has' : 's have'} no recorded unit cost and ${missingCost === 1 ? 'is' : 'are'} shown at zero cost (highlighted).`);
  const kpis = deals.length ? [{ label: 'Average gross per unit', value: centsLabel(Math.round(total.gross / deals.length)), hint: `gross ${total.price ? ((total.gross / total.price) * 100).toFixed(1) : '0.0'}% of sales` }] : [];
  return makeReport('dealer_unit_gross', input.entityLabel, { start: input.start, end: input.end }, cols, rows, notes, kpis);
}

