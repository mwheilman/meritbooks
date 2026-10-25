import { describe, expect, it } from 'vitest';
import { categoryOf, parseDevImport } from './import';

describe('development migration (RED-44)', () => {
  it('budget: section rows set the category, totals are skipped, cents are exact', () => {
    const csv = ['Line item,Code,Budget', 'Land costs,,', 'Purchase price,01-100,"$1,250,000.00"', 'Hard costs,,', 'Sitework,02-200,310000.10', 'Contingency,02-900,50000',
      'Subtotal,,1610000.10', 'Interest reserve,05-100,120000', 'Bad line,9,-5'].join('\n');
    const r = parseDevImport('BUDGET', csv);
    expect(r.rows.map((x) => [x.name, x.category, x.amount_cents])).toEqual([
      ['Purchase price', 'LAND', 125000000], ['Sitework', 'HARD', 31000010], ['Contingency', 'CONTINGENCY', 5000000], ['Interest reserve', 'INTEREST_RESERVE', 12000000],
    ]);
    expect(r.totalCents).toBe(125000000 + 31000010 + 5000000 + 12000000);
    expect(r.issues).toEqual([expect.objectContaining({ message: expect.stringMatching(/negative/) })]);
  });

  it('draw history: approved falls back to funded and the reverse', () => {
    const r = parseDevImport('DRAWS', 'Draw #,Period End,Requested,Approved,Funded,Funding Date\n1,2026-03-31,100000,,95000,2026-04-10\n2,2026-04-30,80000,80000,,\nx,,,,,\n');
    expect(r.rows).toEqual([
      { draw_number: 1, period_end: '2026-03-31', requested_cents: 10000000, approved_cents: 9500000, funded_cents: 9500000, funded_on: '2026-04-10' },
      { draw_number: 2, period_end: '2026-04-30', requested_cents: 8000000, approved_cents: 8000000, funded_cents: 8000000, funded_on: null },
    ]);
    expect(r.issues).toHaveLength(1);
  });

  it('lien waivers: type and status from loose text', () => {
    const r = parseDevImport('WAIVERS', 'Subcontractor,Waiver Type,Received,Through Date,Amount\nAcme Electric,Conditional progress,yes,2026-05-31,42000\nBest Plumbing,Final unconditional,no,,\n');
    expect(r.rows).toEqual([
      { vendor_name: 'Acme Electric', doc_type: 'LIEN_WAIVER_CONDITIONAL', status: 'RECEIVED', covers_through: '2026-05-31', amount_cents: 4200000 },
      { vendor_name: 'Best Plumbing', doc_type: 'LIEN_WAIVER_FINAL', status: 'MISSING', covers_through: null, amount_cents: null },
    ]);
  });

  it('missing columns are reported, and category words map', () => {
    expect(parseDevImport('BUDGET', 'foo,bar\n1,2').issues[0]!.message).toMatch(/amount/);
    expect(categoryOf('Architect and engineering')).not.toBe('LAND');
    expect(categoryOf('Land acquisition')).toBe('LAND');
    expect(categoryOf(null)).toBe('OTHER');
  });
});
