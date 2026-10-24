import { describe, expect, it } from 'vitest';
import { bridgeTable, categoryTable, centsToDecimal, chartTableToCsv, neutralizeCsvFormula, shareTable, timeSeriesTable } from './table';
import { chartTableToXlsx, crc32 } from './xlsx';
import type { TimeSeriesData } from './types';

const data: TimeSeriesData = {
  periods: [
    { key: '2026-06', label: 'Jun', longLabel: 'Jun 2026' },
    { key: '2026-07', label: 'Jul', longLabel: 'Jul 2026' },
    { key: '2026-08', label: 'Aug', longLabel: 'Aug 2026', status: 'preliminary' },
  ],
  actual: [1_000_000_00, null, 1_240_000_99],
  priorYear: [900_000_00, 950_000_00, 1_096_000_00],
  budget: [1_050_000_00, 1_100_000_00, null],
};

describe('table view matches the chart data', () => {
  const t = timeSeriesTable(data, { caption: 'Revenue by month', unit: 'money' });

  it('one row per period, same order, same values (no rounding, no zero-filling)', () => {
    expect(t.rows.map((r) => r.key)).toEqual(data.periods.map((p) => p.key));
    const col = (k: string) => t.columns.findIndex((c) => c.key === k);
    t.rows.forEach((r, i) => {
      expect(r.cells[col('actual')]).toBe(data.actual[i]);
      expect(r.cells[col('priorYear')]).toBe(data.priorYear?.[i]);
      expect(r.cells[col('budget')]).toBe(data.budget?.[i]);
    });
    expect(t.rows[1].cells[col('actual')]).toBeNull(); // the gap stays a gap
  });

  it('carries period status for the P / F markers', () => {
    expect(t.rows[2].status).toBe('preliminary');
    expect(t.rows[2].cells[t.columns.length - 1]).toBe('Preliminary');
  });

  it('omits comparison columns the data does not have', () => {
    const lean = timeSeriesTable({ periods: data.periods, actual: data.actual }, { caption: 'x', unit: 'money' });
    expect(lean.columns.map((c) => c.key)).toEqual(['period', 'actual', 'status']);
  });

  it('category and bridge tables', () => {
    const c = categoryTable(
      [{ key: 'a', label: 'Heritage' }, { key: 'b', label: 'Swan Creek' }],
      [{ key: 'rev', label: 'Revenue', values: [100, null] }, { key: 'cost', label: 'Cost', values: [40, 10] }],
      { caption: 'x', unit: 'money', total: true },
    );
    expect(c.rows[0].cells).toEqual(['Heritage', 100, 40, 140]);
    expect(c.rows[1].cells).toEqual(['Swan Creek', null, 10, 10]);
    const b = bridgeTable(
      [
        { key: 's', label: 'Start', kind: 'start', value: 100 },
        { key: 'd', label: 'Up', kind: 'delta', value: 25 },
        { key: 'e', label: 'End', kind: 'end', value: 125 },
      ],
      { caption: 'Bridge', unit: 'money' },
    );
    expect(b.rows.map((r) => r.cells)).toEqual([
      ['Start', null, 100],
      ['Up', 25, 125],
      ['End', null, 125],
    ]);
    expect(b.notes).toBeUndefined();
  });

  it('share table totals only positive contributors', () => {
    const s = shareTable(
      [
        { key: 'a', label: 'A', value: 300 },
        { key: 'b', label: 'B', value: 100 },
        { key: 'l', label: 'L', value: -40 },
      ],
      { caption: 'Share', unit: 'money' },
    );
    const total = s.rows[s.rows.length - 1];
    expect(total.cells).toEqual(['Total (positive contributors)', 400, 1]);
    expect(s.rows.find((r) => r.key === 'l')?.cells).toEqual(['L (loss)', -40, null]);
  });
});

describe('CSV export', () => {
  const csv = chartTableToCsv(timeSeriesTable(data, { caption: 'Revenue, by month', unit: 'money' }), ['Period: Jun – Aug 2026']);
  const lines = csv.split('\r\n');

  it('banner, header with units, then rows', () => {
    expect(lines[0]).toBe('"Revenue, by month"');
    expect(lines[1]).toBe('Period: Jun – Aug 2026');
    expect(lines[2]).toBe('');
    expect(lines[3]).toBe('Period,Actual ($),Prior year ($),Budget ($),Status');
  });

  it('money as decimal dollars from integer cents; gaps EMPTY (never 0)', () => {
    expect(lines[4]).toBe('Jun 2026,1000000.00,900000.00,1050000.00,Closed');
    expect(lines[5]).toBe('Jul 2026,,950000.00,1100000.00,Closed');
    expect(lines[6]).toBe('Aug 2026,1240000.99,1096000.00,,Preliminary');
  });

  it('centsToDecimal is exact integer arithmetic', () => {
    expect(centsToDecimal(5)).toBe('0.05');
    expect(centsToDecimal(-123_45)).toBe('-123.45');
    expect(centsToDecimal(900_719_925_474_099)).toBe('9007199254740.99');
  });

  it('percent cells export as "13.1%" (Excel reads a number)', () => {
    const t = categoryTable([{ key: 'a', label: 'A' }], [{ key: 'm', label: 'Margin', values: [0.131] }], { caption: 'm', unit: 'percent' });
    expect(chartTableToCsv(t).split('\r\n')[3]).toBe('A,13.1%');
  });

  it('neutralises formula injection in TEXT cells (CWE-1236); numbers stay numeric', () => {
    for (const evil of ['=HYPERLINK("http://x","y")', '+1+cmd', '-2+3', '@SUM(A1)', '\tx', '\rx', '＝1+1', '＋1', '－1', '＠x']) {
      expect(neutralizeCsvFormula(evil)).toBe(`'${evil}`);
    }
    for (const plain of ['-12.5%', '+3', '-1,500.25', '42', 'Acme', '', 'a=b']) expect(neutralizeCsvFormula(plain)).toBe(plain);

    const t = {
      caption: '=cmd|"/c calc"!A1',
      columns: [{ key: 'item', label: '@Vendor' }, { key: 'v', label: 'Spend', unit: 'money' as const }, { key: 'p', label: 'Share', unit: 'percent' as const }],
      rows: [
        { key: 'a', cells: ['=1+1', -150_099, -0.125] },
        { key: 'b', cells: ['-12.5%', 100, 0.5] },
        { key: 'c', cells: ['+SUM(A1:A9)', null, null] },
      ],
      notes: ['-note'],
    };
    const lines = chartTableToCsv(t, ['@meta']).split('\r\n');
    expect(lines[0]).toBe(`"'=cmd|""/c calc""!A1"`);
    expect(lines[1]).toBe("'@meta");
    expect(lines[3]).toBe("'@Vendor,Spend ($),Share");
    expect(lines[4]).toBe("'=1+1,-1500.99,-12.5%"); // negative money / percent stay real numbers
    expect(lines[5]).toBe('-12.5%,1.00,50%'); // a plain signed percent label is not a formula
    expect(lines[6]).toBe("'+SUM(A1:A9),,");
    expect(lines[7]).toBe("'-note");
  });
});

/** Read a stored (method 0) ZIP back into { name → text } for assertions. */
function unzipStored(bytes: Uint8Array): Record<string, string> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Record<string, string> = {};
  let p = 0;
  const dec = new TextDecoder();
  while (dv.getUint32(p, true) === 0x04034b50) {
    const method = dv.getUint16(p + 8, true);
    const crc = dv.getUint32(p + 14, true);
    const size = dv.getUint32(p + 18, true);
    const nameLen = dv.getUint16(p + 26, true);
    const extra = dv.getUint16(p + 28, true);
    const name = dec.decode(bytes.subarray(p + 30, p + 30 + nameLen));
    const start = p + 30 + nameLen + extra;
    const data = bytes.subarray(start, start + size);
    expect(method).toBe(0);
    expect(crc32(data)).toBe(crc);
    out[name] = dec.decode(data);
    p = start + size;
  }
  return out;
}

describe('XLSX export', () => {
  const bytes = chartTableToXlsx(timeSeriesTable(data, { caption: 'Revenue by month', unit: 'money' }), ['Books closed through Jul 2026']);
  const files = unzipStored(bytes);

  it('is a valid OOXML package', () => {
    expect(Object.keys(files).sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml'].sort());
    expect(files['xl/workbook.xml']).toContain('name="Revenue by month"');
  });

  it('money cells are numeric dollars with the accounting format; gaps are absent', () => {
    const sheet = files['xl/worksheets/sheet1.xml'];
    expect(sheet).toContain('<c r="B5" s="2"><v>1000000</v></c>');
    expect(sheet).toContain('<c r="B7" s="2"><v>1240000.99</v></c>');
    expect(sheet).not.toMatch(/<c r="B6"[^>]*>/); // Jul actual missing → no cell, not 0
    expect(sheet).toContain('Books closed through Jul 2026');
    expect(sheet).toContain('state="frozen"');
  });

  it('escapes XML in captions and labels', () => {
    const f = unzipStored(chartTableToXlsx({ caption: 'P&L <draft>', columns: [{ key: 'a', label: 'A & B' }], rows: [{ key: 'r', cells: ['x < y'] }] }));
    expect(f['xl/worksheets/sheet1.xml']).toContain('P&amp;L &lt;draft&gt;');
    expect(f['xl/worksheets/sheet1.xml']).toContain('x &lt; y');
  });
});
