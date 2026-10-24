import { describe, expect, it } from 'vitest';
import { neutralizeFormula, toCsv } from './csv';
import { stampUngoverned, UNGOVERNED_FOOTNOTE, type StatementModel } from './statement-model';
import { toStatementModel } from '@/lib/reports/engine/to-model';
import type { ReportResult } from '@/lib/reports/engine/types';

function model(over: Partial<StatementModel> = {}): StatementModel {
  return {
    title: 'P&L',
    entityLabel: 'Alpha',
    periodLabel: 'Sep 2026',
    generatedAt: '2026-10-24T00:00:00Z',
    columns: [{ key: 'amt', label: 'Amount', money: true }, { key: 'pct', label: '%' }],
    rows: [
      { kind: 'account', label: '=HYPERLINK("http://evil","click")', code: '+4000', values: [-150099, '-12.5%'] },
      { kind: 'account', label: '@SUM(A1:A9)', values: [100, '=1+1'] },
      { kind: 'account', label: '-2+3', values: [0, '\t=cmd'] },
      { kind: 'account', label: '＝WEBSERVICE()', values: [null, null] },
      { kind: 'account', label: 'Rent - office', values: [5000, '+3'] },
    ],
    ...over,
  };
}

describe('CSV formula injection (CWE-1236)', () => {
  const csv = toCsv(model());
  const lines = csv.split('\r\n');

  it('text cells starting with = + - @ tab CR (and full-width) are prefixed with a quote', () => {
    expect(neutralizeFormula('=1+1')).toBe("'=1+1");
    // a plain signed number can't execute — it is left alone (Excel reads it as a number)
    expect(neutralizeFormula('+4000')).toBe('+4000');
    expect(neutralizeFormula('+4000+cmd')).toBe("'+4000+cmd");
    expect(neutralizeFormula('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(neutralizeFormula('-2+3')).toBe("'-2+3");
    expect(neutralizeFormula('\t=cmd')).toBe("'\t=cmd");
    expect(neutralizeFormula('\r=cmd')).toBe("'\r=cmd");
    expect(neutralizeFormula('＝WEBSERVICE()')).toBe("'＝WEBSERVICE()");
    expect(neutralizeFormula('Rent - office')).toBe('Rent - office');
    expect(csv).toContain(`+4000,"'=HYPERLINK(""http://evil"",""click"")"`);
    expect(csv).toContain("'@SUM(A1:A9)");
    expect(csv).toContain("'=1+1");
    expect(csv).toContain("'＝WEBSERVICE()");
  });

  it('negative money stays a real number cell; plain signed numbers / percents are not quoted', () => {
    const row = lines.find((l) => l.includes('HYPERLINK'))!;
    expect(row.endsWith(',-1500.99,-12.5%')).toBe(true);
    expect(lines.find((l) => l.startsWith(',Rent - office'))).toBe(',Rent - office,50,+3');
  });
});

describe('exports keep the governance marks', () => {
  it('CSV writes the watermark, banner and footnote', () => {
    const csv = toCsv(model({ watermark: 'PREVIEW — NOT RELEASED', banner: 'Preview — not released.', footnote: 'Books closed through Aug 2026.' }));
    expect(csv).toContain('PREVIEW — NOT RELEASED');
    expect(csv).toContain('Preview — not released.');
    expect(csv.trim().endsWith('Books closed through Aug 2026.')).toBe(true);
  });

  it('a client-built model loses client-supplied marks and is stamped ungoverned', () => {
    const m = stampUngoverned(model({ watermark: null, banner: 'Released', footnote: 'Final and released' }));
    expect(m).toMatchObject({ watermark: null, banner: null, footnote: UNGOVERNED_FOOTNOTE });
  });

  it('toStatementModel carries the governed result’s watermark / banner / footnote', () => {
    const r = {
      statement: 'income_statement', title: 'Income statement', subtitle: 'Alpha · Sep 2026', basis: 'ACCRUAL', basisLabel: 'Accrual', rounding: 'cents',
      range: { start: '2026-09-01', end: '2026-09-30' },
      columns: [{ id: 'cur', label: 'Sep', kind: 'amount', source: 'actual', range: { start: '2026-09-01', end: '2026-09-30' } }],
      rows: [{ id: 'rev', kind: 'account', label: 'Revenue', depth: 0, values: [null] }],
      warnings: [], notes: [], companies: [{ id: 'a', name: 'Alpha' }], checks: [], chartSeries: [], generatedAt: '2026-10-24T00:00:00Z',
      governance: { watermark: 'preview', banner: { tone: 'warn', text: 'Preview — not released.' }, footnote: 'Books closed through Aug 2026.', withheldColumnIds: [] },
    } as unknown as ReportResult;
    const m = toStatementModel(r);
    expect(m).toMatchObject({ watermark: 'PREVIEW — NOT RELEASED', banner: 'Preview — not released.', footnote: 'Books closed through Aug 2026.' });
  });
});
