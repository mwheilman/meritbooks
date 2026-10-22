import { describe, expect, it } from 'vitest';
import type { AccessRow, PersonaKey } from '@/lib/access/types';
import { buildAccess } from '@/lib/access/derive';
import { PERSONA_TEMPLATE_GRANTS } from '@/lib/access/templates';
import { maskMoney, metricVisible, seesAllMoney } from '@/lib/access/mask';
import { MONEY_KEYS, MONEY_OBJECTS, rulesFor, type MoneyClass, type MoneyKeyList } from '@/lib/access/money-keys';

const L1 = '11111111-1111-4111-8111-111111111111';
const L2 = '22222222-2222-4222-8222-222222222222';

function rowsFor(persona: PersonaKey, loc: string): AccessRow[] {
  const byCap = new Map<string, string[]>();
  for (const g of PERSONA_TEMPLATE_GRANTS[persona]) {
    const [cap, action] = g.split(':') as [string, string];
    byCap.set(cap, [...(byCap.get(cap) ?? []), action]);
  }
  return [...byCap].map(([capability, actions]) => ({ location_id: loc, capability, actions, role_key: persona, role_name: null }));
}
const as = (p: PersonaKey, loc = L1) => buildAccess(rowsFor(p, loc));

const owner = as('projects_owner');
const gm = as('projects_gm');
const pm = as('projects_pm');
const office = as('projects_office_manager');
const purchasing = as('projects_purchasing');
const labor = as('projects_labor');
const supervisor = as('projects_supervisor');
const dispatcher = as('projects_dispatcher');

const CLASSES: MoneyClass[] = ['financials', 'contract_value', 'labor_rates'];
const HOLDS: Record<string, MoneyClass[]> = {
  owner: ['financials', 'contract_value', 'labor_rates'],
  gm: ['financials', 'contract_value', 'labor_rates'],
  pm: ['financials', 'contract_value'],
  office: ['contract_value'],
  purchasing: ['financials'],
  labor: [],
  supervisor: [],
  dispatcher: [],
};
const WHO = { owner, gm, pm, office, purchasing, labor, supervisor, dispatcher };

describe('money key list', () => {
  it('every object type lists at least one money key, and no key is both public and money in one type', () => {
    for (const o of MONEY_OBJECTS) {
      const k: MoneyKeyList = MONEY_KEYS[o];
      const money = CLASSES.flatMap((c) => [...(k[c] ?? [])]);
      expect(money.length, o).toBeGreaterThan(0);
      for (const p of k.public ?? []) expect(money, `${o}.${p}`).not.toContain(p);
    }
  });

  it('the spec examples are classified as the spec says', () => {
    const r = (o: Parameters<typeof rulesFor>[0]) => rulesFor(o).money;
    expect(r(['job']).get('original_contract_cents')).toEqual(['contract_value']);
    expect(r(['job']).get('projected_margin_cents')).toEqual(['financials']);
    expect(r(['budget']).get('amount_cents')).toEqual(['financials']);
    expect(r(['commitment']).get('revised_amount_cents')).toEqual(['financials']);
    expect(r(['billing']).get('amount_cents')).toEqual(['contract_value']);
    expect(r(['change_order']).get('amount_cents')).toEqual(['contract_value']);
    expect(r(['change_order']).get('cost_impact_cents')).toEqual(['financials']);
    expect(r(['estimate']).get('unit_price_cents')).toEqual(['contract_value']);
    expect(r(['estimate']).get('unit_cost_cents')).toEqual(['financials']);
    expect(r(['dealer_deal']).get('total_gross_cents')).toEqual(['financials']);
    expect(r(['time_entry']).get('cost_rate_cents')).toEqual(['labor_rates']);
    expect(r(['labor_rate']).get('base_rate_cents')).toEqual(['labor_rates']);
    expect(r(['labor_rate']).get('bill_rate_cents')).toEqual(['contract_value']);
  });

  it('the strict union (no declared type) needs every class a key has anywhere', () => {
    const u = rulesFor().money;
    expect([...(u.get('amount_cents') ?? [])].sort()).toEqual(['contract_value', 'financials']);
    expect(u.has('committed')).toBe(false); // generic names only inside a declared type
    expect(u.has('pct')).toBe(false);
    expect(rulesFor().public.has('price_cents')).toBe(false); // money for deals/agreements
    expect(rulesFor(['price_book']).public.has('price_cents')).toBe(true);
  });
});

/** A sample row of an object type: every listed key set to 1234, plus a non-money field. */
function sample(o: (typeof MONEY_OBJECTS)[number]): Record<string, unknown> {
  const k: MoneyKeyList = MONEY_KEYS[o];
  const row: Record<string, unknown> = { id: 'x', location_id: L1, name: 'Row', qty: 3 };
  for (const c of CLASSES) for (const key of k[c] ?? []) row[key] = 1234;
  for (const key of k.public ?? []) row[key] = 999;
  return row;
}

describe.each(MONEY_OBJECTS.map((o) => [o]))('maskMoney · %s', (o) => {
  const k: MoneyKeyList = MONEY_KEYS[o];
  const rules = rulesFor([o]).money;
  it.each(Object.keys(WHO).map((w) => [w]))('%s sees exactly the classes they hold', (who) => {
    const out = maskMoney(sample(o), WHO[who as keyof typeof WHO], null, o);
    const held = HOLDS[who]!;
    for (const [key, classes] of rules) {
      const visible = classes.every((c) => held.includes(c));
      expect(out[key], `${who} ${o}.${key}`).toBe(visible ? 1234 : null);
    }
    for (const key of k.public ?? []) expect(out[key], `${who} public ${o}.${key}`).toBe(999);
    expect(out.name).toBe('Row');
    expect(out.qty).toBe(3);
  });
});

describe('maskMoney behaviour', () => {
  it('owner fast path returns the same object; others get a copy (input untouched)', () => {
    const v = { amount_cents: 5 };
    expect(seesAllMoney(owner)).toBe(true);
    expect(maskMoney(v, owner)).toBe(v);
    const m = maskMoney(v, labor);
    expect(m).not.toBe(v);
    expect(v.amount_cents).toBe(5);
    expect(m.amount_cents).toBeNull();
  });

  it('labor: no contract, budget, cost, margin or pay anywhere in a nested payload', () => {
    const payload = {
      job: { location_id: L1, name: 'Kitchen', original_contract_cents: 100, projected_margin_pct: 0.2, budget_total_cents: 80 },
      lines: [{ amount_cents: 10, unit_cost_cents: 5, description: 'Tile' }],
      time: [{ hours: 8, cost_rate_cents: 4200, bill_rate_cents: 9000 }],
      totals: { front_gross_cents: 300, someNewCents: 7, count: 4 },
    };
    const m = maskMoney(payload, labor, L1);
    expect(m.job).toEqual({ location_id: L1, name: 'Kitchen', original_contract_cents: null, projected_margin_pct: null, budget_total_cents: null });
    expect(m.lines[0]).toEqual({ amount_cents: null, unit_cost_cents: null, description: 'Tile' });
    expect(m.time[0]).toEqual({ hours: 8, cost_rate_cents: null, bill_rate_cents: null });
    expect(m.totals).toEqual({ front_gross_cents: null, someNewCents: null, count: 4 });
  });

  it('unknown money-looking keys need both financials and contract_value (fail closed)', () => {
    const v = { brand_new_cents: 1, newMarginThing: 2 };
    expect(maskMoney(v, office)).toEqual({ brand_new_cents: null, newMarginThing: null });
    expect(maskMoney(v, purchasing)).toEqual({ brand_new_cents: null, newMarginThing: null });
    expect(maskMoney(v, pm)).toEqual(v);
  });

  it('PM: full money but no individual rates', () => {
    expect(maskMoney({ cost_rate_cents: 4200, base_rate_cents: 3000, bill_rate_cents: 9000 }, pm, L1, 'labor_rate'))
      .toEqual({ cost_rate_cents: null, base_rate_cents: null, bill_rate_cents: 9000 });
  });

  it('company scope: the row\'s location_id decides, not the request', () => {
    const mixed = buildAccess([...rowsFor('projects_pm', L1), ...rowsFor('projects_labor', L2)]);
    const rows = [
      { location_id: L1, original_contract_cents: 100 },
      { location_id: L2, original_contract_cents: 200 },
      { locationId: L2, items: [{ amountCents: 5 }] },
    ];
    expect(maskMoney(rows, mixed, null, ['job', 'billing'])).toEqual([
      { location_id: L1, original_contract_cents: 100 },
      { location_id: L2, original_contract_cents: null },
      { locationId: L2, items: [{ amountCents: null }] },
    ]);
    // no company on the row → the request company
    expect(maskMoney({ original_contract_cents: 1 }, mixed, L2, 'job')).toEqual({ original_contract_cents: null });
    expect(maskMoney({ original_contract_cents: 1 }, mixed, L1, 'job')).toEqual({ original_contract_cents: 1 });
  });

  it('never blanks arrays, objects, strings or booleans under a money name', () => {
    const v = { changes: [{ id: 'c1' }], committed: { note: 'x' }, cost: 'n/a', margin: true, amount_cents: '12345' };
    const m = maskMoney(v, labor, null, ['commitment', 'estimate']);
    expect(m.changes).toEqual([{ id: 'c1' }]);
    expect(m.committed).toEqual({ note: 'x' });
    expect(m.cost).toBe('n/a');
    expect(m.margin).toBe(true);
    expect(m.amount_cents).toBeNull(); // bigint as a numeric string is still a figure
  });

  it('generic names are left alone when no type is declared', () => {
    expect(maskMoney({ open: 3, pct: 0.5, committed: 2 }, labor)).toEqual({ open: 3, pct: 0.5, committed: 2 });
    expect(maskMoney({ received: 3, committed: 2, open: 1 }, labor, null, 'commitment')).toEqual({ received: null, committed: null, open: 1 });
  });

  it('dispatcher sees price-book sell, not cost', () => {
    const items = [{ id: 'p', companyId: L1, priceCents: 15000, cost_cents: 9000, price_cents: 15000 }];
    expect(maskMoney(items, dispatcher, null, 'price_book')).toEqual([{ id: 'p', companyId: L1, priceCents: 15000, cost_cents: null, price_cents: 15000 }]);
  });

  it('supervisor sees hours and quantities on a cost-code status row', () => {
    const row = { cost_code: '0610', budget_cents: 100, actual_cents: 50, hours: 12, qty: 40 };
    expect(maskMoney(row, supervisor, L1, 'budget')).toEqual({ cost_code: '0610', budget_cents: null, actual_cents: null, hours: 12, qty: 40 });
  });

  it('a preview narrows masking too (owner previewing labor)', () => {
    const preview = buildAccess(rowsFor('projects_owner', L1), { preview: 'projects_labor' });
    expect(seesAllMoney(preview)).toBe(false);
    expect(maskMoney({ amount_cents: 1 }, preview, L1)).toEqual({ amount_cents: null });
  });
});

describe('metricVisible (formatted KPI signals)', () => {
  it('money KPIs follow their class; counts and rates are free', () => {
    expect(metricVisible(labor, 'avg_ticket_cents', L1)).toBe(false);
    expect(metricVisible(office, 'avg_ticket_cents', L1)).toBe(true);
    expect(metricVisible(office, 'product_margin_pct', L1)).toBe(false);
    expect(metricVisible(pm, 'product_margin_pct', L1)).toBe(true);
    expect(metricVisible(labor, 'first_time_fix_pct', L1)).toBe(true);
    expect(metricVisible(labor, 'interest_reserve_months', L1)).toBe(false);
    expect(metricVisible(pm, 'avg_ticket_cents', L2)).toBe(false); // not held at L2
  });
});
