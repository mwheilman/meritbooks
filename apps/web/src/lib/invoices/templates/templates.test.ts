import { describe, it, expect } from 'vitest';
import { pickTemplate, templateAppliesTo } from './resolve';
import { allocateLineTax, buildLineTable, columnWidths } from './columns';
import { BUILT_IN_TEMPLATE, normalizeColumns, templateFromRow, type InvoiceTemplate } from './types';
import { templateBodySchema, uniqueName, bodyFromTemplate } from './schema';

const LOC = 'loc-a';
const tpl = (over: Partial<InvoiceTemplate>): InvoiceTemplate => ({ ...BUILT_IN_TEMPLATE, id: 'x', org_id: 'o', ...over });

describe('pickTemplate — most specific wins', () => {
  const orgDefault = tpl({ id: 'org', location_id: null, is_default: true });
  const coDefault = tpl({ id: 'co', location_id: LOC, is_default: true });
  const cust = tpl({ id: 'cust', location_id: LOC });
  const inv = tpl({ id: 'inv', location_id: null });
  const otherCo = tpl({ id: 'other', location_id: 'loc-b' });
  const all = [orgDefault, coDefault, cust, inv, otherCo];

  it('invoice → customer → company default → org default → built-in', () => {
    expect(pickTemplate({ invoiceTemplateId: 'inv', customerTemplateId: 'cust', locationId: LOC, templates: all })).toMatchObject({ source: 'INVOICE' });
    expect(pickTemplate({ customerTemplateId: 'cust', locationId: LOC, templates: all }).template.id).toBe('cust');
    expect(pickTemplate({ locationId: LOC, templates: all }).template.id).toBe('co');
    expect(pickTemplate({ locationId: 'loc-c', templates: all }).template.id).toBe('org');
    expect(pickTemplate({ locationId: LOC, templates: [] })).toEqual({ template: BUILT_IN_TEMPLATE, source: 'BUILT_IN' });
  });

  it('a template of another company never applies (stale assignment falls through)', () => {
    expect(templateAppliesTo(otherCo, LOC)).toBe(false);
    expect(pickTemplate({ invoiceTemplateId: 'other', customerTemplateId: 'other', locationId: LOC, templates: all }).template.id).toBe('co');
  });
});

describe('templateFromRow', () => {
  it('maps the legacy emerald default to Electric Blue and forces required columns', () => {
    const t = templateFromRow({ id: '1', accent_color: '#10b981', visible_columns: ['rate', 'bogus'], style: 'NOPE', font: 'COMIC' });
    expect(t.accent_color).toBe('#2563EB');
    expect(t.visible_columns).toEqual(['description', 'rate', 'amount']);
    expect(t.style).toBe('MODERN');
    expect(t.font).toBe('SANS');
    expect(t.show_qr).toBe(true);
  });

  it('keeps a tenant colour and drops malformed custom fields', () => {
    const t = templateFromRow({ accent_color: '#8A2D3B', custom_fields: [{ label: 'License', value: 'X' }, { value: 'no label' }, 'junk'], line_fields: [{ key: 'room', label: 'Room' }, { key: '', label: 'x' }] });
    expect(t.accent_color).toBe('#8A2D3B');
    expect(t.custom_fields).toEqual([{ label: 'License', value: 'X', placement: 'HEADER' }]);
    expect(t.line_fields).toEqual([{ key: 'room', label: 'Room' }]);
  });

  it('normalizeColumns keeps canonical order', () => {
    expect(normalizeColumns(['amount', 'item', 'tax'])).toEqual(['item', 'description', 'tax', 'amount']);
  });
});

describe('buildLineTable — the template’s columns are honoured', () => {
  const lines = [
    { line_number: 1, description: 'Install', quantity: 1, unit_price_cents: 85_000, amount_cents: 85_000, cost_code_label: '06-400 Cabinetry', service_date: '2026-05-20', tax_cents: 4_760, custom_fields: { room: 'Kitchen' } },
    { line_number: 2, description: 'Templating', quantity: 4, unit_price_cents: 10_000, amount_cents: 40_000, tax_cents: 2_240 },
  ];

  it('prints exactly the chosen columns, in canonical order, with custom line fields', () => {
    const t = buildLineTable(lines, { visible_columns: ['description', 'cost_code', 'service_date', 'quantity', 'amount', 'custom'], line_fields: [{ key: 'room', label: 'Room' }] });
    expect(t.columns.map((c) => c.key)).toEqual(['description', 'service_date', 'cost_code', 'custom:room', 'quantity', 'amount']);
    expect(t.rows[0].cells).toMatchObject({ description: 'Install', cost_code: '06-400 Cabinetry', 'custom:room': 'Kitchen', amount: '$850.00' });
    expect(t.rows[0].cells.service_date).toBe('May 20, 2026');
    expect(t.columns.find((c) => c.key === 'rate')).toBeUndefined();
  });

  it('drops an optional column that is empty on every line (unless hideEmpty is off)', () => {
    const t = buildLineTable(lines, { visible_columns: ['item', 'description', 'job', 'amount'], line_fields: [] });
    expect(t.columns.map((c) => c.key)).toEqual(['description', 'amount']);
    const keep = buildLineTable(lines, { visible_columns: ['item', 'description', 'amount'], line_fields: [] }, { hideEmpty: false });
    expect(keep.columns.map((c) => c.key)).toEqual(['item', 'description', 'amount']);
    const job = buildLineTable(lines, { visible_columns: ['description', 'job', 'amount'], line_fields: [] }, { jobLabel: 'J-1 · Smith' });
    expect(job.rows[1].cells.job).toBe('J-1 · Smith');
  });

  it('never carries an account number (the input has none to carry)', () => {
    const t = buildLineTable(lines, { visible_columns: [...normalizeColumns(['item', 'description', 'service_date', 'job', 'cost_code', 'quantity', 'rate', 'tax', 'amount'])], line_fields: [] });
    expect(JSON.stringify(t)).not.toMatch(/account/i);
  });

  it('column widths add up to 100%', () => {
    const t = buildLineTable(lines, { visible_columns: ['description', 'quantity', 'rate', 'tax', 'amount'], line_fields: [] });
    const total = columnWidths(t.columns).reduce((s, w) => s + parseFloat(w), 0);
    expect(total).toBeCloseTo(100, 1);
  });
});

describe('allocateLineTax', () => {
  it('splits the tax across taxable lines and ties to the cent', () => {
    const out = allocateLineTax([{ amount_cents: 33_333, taxable: true }, { amount_cents: 33_333, taxable: true }, { amount_cents: 33_334, taxable: true }], 7_001);
    expect(out.reduce((s, x) => s + x, 0)).toBe(7_001);
    expect(Math.max(...out) - Math.min(...out)).toBeLessThanOrEqual(1);
  });
  it('balance-sheet lines (retainage release, deposit) carry no tax', () => {
    expect(allocateLineTax([{ amount_cents: 100_000, taxable: true }, { amount_cents: 50_000, taxable: false }], 7_000)).toEqual([7_000, 0]);
  });
  it('no tax or no taxable base → zeros', () => {
    expect(allocateLineTax([{ amount_cents: 100, taxable: false }], 50)).toEqual([0]);
    expect(allocateLineTax([{ amount_cents: 100, taxable: true }], 0)).toEqual([0]);
  });
});

describe('templateBodySchema', () => {
  const base = bodyFromTemplate(BUILT_IN_TEMPLATE);
  it('accepts the built-in template', () => {
    expect(templateBodySchema.safeParse(base).success).toBe(true);
  });
  it('refuses a bad colour, an http logo and duplicate line-field keys', () => {
    expect(templateBodySchema.safeParse({ ...base, accent_color: 'blue' }).success).toBe(false);
    expect(templateBodySchema.safeParse({ ...base, logo_url: 'http://x.test/logo.png' }).success).toBe(false);
    expect(templateBodySchema.safeParse({ ...base, line_fields: [{ key: 'a', label: 'A' }, { key: 'a', label: 'B' }] }).success).toBe(false);
  });
  it('always keeps description + amount', () => {
    const r = templateBodySchema.parse({ ...base, visible_columns: ['rate'] });
    expect(r.visible_columns).toEqual(['description', 'rate', 'amount']);
  });
  it('uniqueName avoids clashes case-insensitively', () => {
    expect(uniqueName('Copy of Standard', ['copy of standard', 'Copy of Standard (2)'])).toBe('Copy of Standard (3)');
    expect(uniqueName('Fresh', ['Other'])).toBe('Fresh');
  });
});
