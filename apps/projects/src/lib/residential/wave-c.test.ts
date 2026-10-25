import { describe, expect, it } from 'vitest';
import { detectKbSource, parseKbFile } from './kb-import';
import { distanceKm, driveMinutes, slotLabel } from './routing';
import { buildResidentialPlan, paymentTemplate, type ResidentialAnswers } from './setup';
import { siteLabels } from './field-i18n';
import { exportFileName, exportPlan, ndjsonLine, toCsv, type ExportTable } from './export';

const A: ResidentialAnswers = { businessKind: 'remodel', contractTypes: ['FIXED_PRICE'], billingMethod: 'MILESTONE', selfPerform: 'MIXED', stateCode: 'IA', taxForm: 'LUMP_SUM_IMPROVEMENT',
  depositPct: 0.1, markupPct: 0.25, workmanshipWarrantyMonths: 12, structuralWarrantyYears: 0, usesSelectionsPortal: true };

describe('K&B import (RES-23)', () => {
  it('reads a 2020-style CSV, finds the header under a title row, and merges duplicate SKUs', () => {
    const csv = ['2020 Design export,,,,', 'SKU,Description,Qty,Door Style,Room,List Price', 'B24,Base 24,1,Shaker White,Kitchen,412.50', 'W3030,Wall 30x30,2,Shaker White,Kitchen,298', 'B24,Base 24,1,Shaker White,Kitchen,412.50'].join('\n');
    const r = parseKbFile('kitchen-2020.csv', csv);
    expect(r.source).toBe('TWENTY_TWENTY');
    expect(r.lines).toHaveLength(2);
    const b24 = r.lines.find((l) => l.sku === 'B24')!;
    expect(b24.qty).toBe(2);
    expect(b24.list_price_cents).toBe(41250);
    expect(r.totals.listCents).toBe(2 * 41250 + 2 * 29800);
    expect(r.issues).toEqual([]);
  });

  it('divides an extended price by the quantity and reports bad quantities', () => {
    const csv = 'Item Code,Description,Quantity,Extended List\nSB36,Sink base,2,1000.00\nX1,Broken,abc,5\n';
    const r = parseKbFile('list.csv', csv, 'PROKITCHEN');
    expect(r.source).toBe('PROKITCHEN');
    expect(r.lines[0]!.list_price_cents).toBe(50000);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.message).toMatch(/quantity/);
  });

  it('reads a Cabinet Vision XML list', () => {
    const xml = '<CabinetVision><Cabinet><Code>B15</Code><Description>Base 15</Description><Qty>3</Qty><Room>Laundry</Room><ListPrice>210.00</ListPrice></Cabinet></CabinetVision>';
    expect(detectKbSource('job.xml', xml)).toBe('CABINET_VISION');
    const r = parseKbFile('job.xml', xml);
    expect(r.lines).toEqual([expect.objectContaining({ sku: 'B15', qty: 3, room: 'Laundry', list_price_cents: 21000 })]);
  });

  it('says so when there is no SKU column', () => {
    expect(parseKbFile('x.csv', 'Foo,Bar\n1,2\n').issues[0]!.message).toMatch(/SKU/);
  });
});

describe('appointment routing (RES-10)', () => {
  it('drive time: km × 1.3 at 50 km/h plus 5, or 30 minutes without coordinates', () => {
    const desMoines = { lat: 41.5868, lng: -93.625 };
    const ames = { lat: 42.0308, lng: -93.6319 };
    const km = distanceKm(desMoines, ames)!;
    expect(km).toBeGreaterThan(48);
    expect(km).toBeLessThan(51);
    expect(driveMinutes(desMoines, ames)).toBe(Math.ceil(((km * 1.3) / 50) * 60 - 1e-9) + 5);
    expect(driveMinutes(desMoines, { lat: null, lng: null })).toBe(30);
    expect(distanceKm(desMoines, desMoines)).toBe(0);
  });

  it('labels a slot in the company time zone', () => {
    expect(slotLabel('2026-10-27T14:30:00Z', 'America/Chicago')).toBe('Tue, Oct 27 · 9:30 AM');
  });
});

describe('setup interview (RES-01)', () => {
  it('a payment schedule always sums to 100 %', () => {
    for (const m of ['MILESTONE', 'PROGRESS', 'DRAW', 'COST_PLUS', 'MIXED'] as const) {
      for (const dep of [0, 0.1, 0.33, 0.9]) {
        const sum = paymentTemplate(m, dep).reduce((s, p) => s + p.pct, 0);
        expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
      }
    }
    expect(paymentTemplate('MILESTONE', 0.9)[0]!.pct).toBe(0.5); // deposit capped at half
  });

  it('a remodeler gets no builder codes, inventory account or structural warranty; a builder does', () => {
    const r = buildResidentialPlan(A);
    expect(r.cost_codes.some((c) => c.code === '31-000')).toBe(false);
    expect(r.books_accounts.spec_inventory).toBeUndefined();
    expect(r.builder_job_types).toBe(false);
    const b = buildResidentialPlan({ ...A, businessKind: 'production', structuralWarrantyYears: 10, selfPerform: 'SUBCONTRACT' });
    expect(b.cost_codes.some((c) => c.code === '31-000')).toBe(true);
    expect(b.cost_codes.filter((c) => c.code < '90').every((c) => c.cost_type === 'SUBCONTRACTOR')).toBe(true);
    expect(b.settings.warranty_walk_days).toContain(730);
    expect(b.books_accounts.spec_inventory).toBeDefined();
  });

  it('drops a bad state code and the library when selections are off', () => {
    const r = buildResidentialPlan({ ...A, stateCode: 'Iowa', usesSelectionsPortal: false });
    expect(r.settings.state_code).toBeNull();
    expect(r.selection_library).toEqual([]);
    expect(r.portal_defaults.selections).toBe(false);
  });
});

describe('field labels (RES-68)', () => {
  it('Spanish when asked, English otherwise', () => {
    expect(siteLabels('es')).not.toEqual(siteLabels('en'));
    expect(siteLabels('fr')).toEqual(siteLabels('en'));
    expect(siteLabels(null)).toEqual(siteLabels('en'));
  });
});

describe('data export (RES-127)', () => {
  const T = (source: string, cls: string, scope = 'job', parent: string | null = null): ExportTable => ({ schema: 'pm', table: source, source, class: cls, scope, parent_table: parent, parent_column: parent ? 'parent_id' : null });
  it('a job export keeps job families (and their children) only, parents before children', () => {
    const plan = exportPlan([T('kids', 'P', 'parent', 'tasks'), T('tasks', 'J'), T('catalog', 'S', 'location'), T('v_costs_masked', 'M')], 'job');
    expect(plan.map((t) => t.source)).toEqual(['tasks', 'v_costs_masked', 'kids']);
    expect(exportPlan([T('catalog', 'S', 'location'), T('tasks', 'J')], 'company')).toHaveLength(2);
  });

  it('CSV quotes what needs quoting and unions the columns', () => {
    expect(toCsv([{ a: 1, b: 'x,y' }, { a: 2, c: { k: 'v' } }])).toBe('a,b,c\r\n1,"x,y",\r\n2,,"{""k"":""v""}"\r\n');
    expect(ndjsonLine('tasks', { id: 1 })).toBe('{"table":"tasks","row":{"id":1}}\n');
    expect(exportFileName('csv', 'Heartland Homes!', '2026-10-25')).toBe('merit-projects-heartland-homes-2026-10-25.csv');
  });
});
