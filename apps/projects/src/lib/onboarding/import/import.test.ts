import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { autoMapColumns, detectHeaderRow, detectVendor, LOW_CONFIDENCE } from './automap';
import { validateMapAnswer } from './ai-map';
import { readCsvGrid } from './grid';
import { gridFromUpload, tableFromGrid } from './parse';
import { mapRecords, matchJobType, rowsToCreate } from './rows';
import { normalizeStatus, parseDate, parseMoneyToCents } from './values';
import { readXlsxGrid } from './xlsx';

const headersOf = (m: ReturnType<typeof autoMapColumns>) =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v!.header]));

describe('money → cents', () => {
  it.each([
    ['$12,500.00', 1_250_000],
    ['12500', 1_250_000],
    ['(1,200)', -120_000],
    ['-$45.10', -4510],
    ['1,234.56 CR', -123_456],
    ['12345.670000000002', 1_234_567],
    ['$ 7,990.5', 799_050],
    ['0.005', 1],
  ])('%s → %d', (raw, cents) => expect(parseMoneyToCents(raw)).toBe(cents));
  it('blank is null, text is undefined', () => {
    expect(parseMoneyToCents('')).toBeNull();
    expect(parseMoneyToCents('-')).toBeNull();
    expect(parseMoneyToCents('TBD')).toBeUndefined();
  });
});

describe('dates and statuses', () => {
  it.each([
    ['2026-03-04', '2026-03-04'],
    ['3/4/2026', '2026-03-04'],
    ['03/04/26', '2026-03-04'],
    ['Mar 4, 2026', '2026-03-04'],
    ['4-Mar-2026', '2026-03-04'],
    ['46085', '2026-03-04'],
    ['2/30/2026', null],
    ['soon', null],
  ])('%s → %s', (raw, iso) => expect(parseDate(raw)).toBe(iso));
  it('statuses collapse to five words', () => {
    expect(normalizeStatus('In Progress')).toBe('active');
    expect(normalizeStatus('Closed')).toBe('complete');
    expect(normalizeStatus('On Hold')).toBe('on_hold');
    expect(normalizeStatus('Pending')).toBe('bid');
    expect(normalizeStatus('Cancelled')).toBe('cancelled');
    expect(normalizeStatus('')).toBeNull();
  });
});

describe('header auto-map', () => {
  it('Buildertrend jobs export', () => {
    const h = ['Job Name', 'Job Status', 'Job Group', 'Owner Name', 'Street Address', 'City', 'State', 'Zip', 'Contract Price', 'Projected Start', 'Projected Completion', 'Project Managers'];
    const m = autoMapColumns(h);
    expect(headersOf(m)).toEqual({
      name: 'Job Name', customer: 'Owner Name', job_type: 'Job Group', contract: 'Contract Price',
      start_date: 'Projected Start', status: 'Job Status', site_address: 'Street Address',
    });
    expect(m.name!.confidence).toBeGreaterThanOrEqual(LOW_CONFIDENCE);
    expect(detectVendor(h)).toBe('Buildertrend');
  });

  it('JobTread jobs export', () => {
    const h = ['Job Number', 'Job Name', 'Customer Name', 'Location Name', 'Location Address', 'Job Stage', 'Price', 'Created'];
    const m = autoMapColumns(h);
    expect(headersOf(m)).toMatchObject({
      external_id: 'Job Number', name: 'Job Name', customer: 'Customer Name', site_address: 'Location Address',
      status: 'Job Stage', contract: 'Price', start_date: 'Created',
    });
    expect(m.contract!.confidence).toBeLessThan(0.95); // "Price" is generic
    expect(detectVendor(h)).toBe('JobTread');
  });

  it('simPRO jobs export', () => {
    const h = ['Job No.', 'Customer', 'Site', 'Name', 'Stage', 'Job Type', 'Date Issued', 'Total (Ex Tax)', 'Total (Inc Tax)', 'Salesperson'];
    const m = autoMapColumns(h);
    expect(headersOf(m)).toMatchObject({
      external_id: 'Job No.', customer: 'Customer', name: 'Name', job_type: 'Job Type',
      start_date: 'Date Issued', contract: 'Total (Ex Tax)', status: 'Stage', site_address: 'Site',
    });
    expect(detectVendor(h)).toBe('simPRO');
  });

  it('fuzzy headers stay low-confidence and blockers keep phones out of customer', () => {
    const m = autoMapColumns(['Project Title Text', 'Customer Phone', 'Primary Customer Name', 'Contract Price USD']);
    expect(m.name).toMatchObject({ header: 'Project Title Text', source: 'fuzzy' });
    expect(m.customer?.header).toBe('Primary Customer Name');
    expect(m.contract).toMatchObject({ header: 'Contract Price USD', source: 'fuzzy' });
    expect(m.name!.confidence).toBeLessThan(LOW_CONFIDENCE);
  });

  it('value sniff finds an unnamed money column', () => {
    const m = autoMapColumns(['Job', 'Column C'], { Job: ['A', 'B'], 'Column C': ['$1,200.00', '$3,400.50'] });
    expect(m.contract).toMatchObject({ header: 'Column C', source: 'values' });
  });

  it('header row is found below report titles', () => {
    const grid = readCsvGrid('Acme Remodeling\nJob list as of Oct 1\n\nJob Name,Customer,Contract Price\nSmith kitchen,Smith,"$12,500.00"\n');
    expect(detectHeaderRow(grid)).toBe(3);
  });

  it('AI answers are limited to unmapped headers and fields, one header per field', () => {
    const m = validateMapAnswer(
      { mappings: [{ header: 'Proj', field: 'name' }, { header: 'Proj', field: 'customer' }, { header: 'Nope', field: 'status' }, { header: 'Who', field: 'contract' }, { header: 'Who', field: 'nonsense' }] },
      ['Proj', 'Who'], ['name', 'customer'],
    );
    expect(m).toEqual({ name: { header: 'Proj', confidence: 0.6, source: 'ai' } });
  });
});

describe('rows', () => {
  const types = [
    { key: 'service_call', label: 'Service call', archetype: 'field_service' },
    { key: 'replacement_install', label: 'Replacement install', archetype: 'project' },
  ];
  it('job types match by label, words or archetype; unknown falls back to the default', () => {
    expect(matchJobType('Service Call', types)?.key).toBe('service_call');
    expect(matchJobType('HVAC Replacement', types)?.key).toBe('replacement_install');
    expect(matchJobType('Install', types)?.key).toBe('replacement_install');
    expect(matchJobType('Banana', types)).toBeNull();
  });

  it('maps, flags issues and duplicates, and skips finished work by default', () => {
    const grid = readCsvGrid([
      'Job Number,Job Name,Customer,Type,Contract Price,Start Date,Status',
      'J-1,Smith kitchen,Smith,Install,"$12,500.00",3/4/2026,In Progress',
      'J-2,Lee bath,Lee,Banana,TBD,soon,Closed',
      'J-1,Smith kitchen again,Smith,,,,Open',
      ',,Nobody,,,,',
    ].join('\n'));
    const t = tableFromGrid(grid, 'jobs.csv');
    if (!t.ok) throw new Error(t.message);
    const rows = mapRecords(t.records, t.rowNumbers, t.mapping, { jobTypes: types, defaultJobTypeKey: 'service_call' });
    expect(rows[0]).toMatchObject({ rowNumber: 2, name: 'Smith kitchen', jobTypeKey: 'replacement_install', contractCents: 1_250_000, startDate: '2026-03-04', status: 'active', invalid: false });
    expect(rows[1]).toMatchObject({ jobTypeKey: 'service_call', contractCents: null, startDate: null, finished: true });
    expect(rows[1].issues.length).toBe(3);
    expect(rows[2]).toMatchObject({ invalid: true });
    expect(rows[2].issues[0]).toMatch(/row 2/);
    expect(rowsToCreate(rows, false).map((r) => r.name)).toEqual(['Smith kitchen']);
    expect(rowsToCreate(rows, true).map((r) => r.name)).toEqual(['Smith kitchen', 'Lee bath']);
  });
});

// --- a hand-built .xlsx (ZIP with a deflated sheet + shared strings) ---
function zip(files: Record<string, string>): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameB = enc.encode(name);
    const data = new Uint8Array(deflateRawSync(enc.encode(text)));
    const lh = new Uint8Array(30 + nameB.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(8, 8, true); lv.setUint32(18, data.length, true);
    lv.setUint16(26, nameB.length, true); lh.set(nameB, 30);
    const ch = new Uint8Array(46 + nameB.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(10, 8, true); cv.setUint32(20, data.length, true);
    cv.setUint16(28, nameB.length, true); cv.setUint32(42, offset, true); ch.set(nameB, 46);
    locals.push(lh, data); centrals.push(ch);
    offset += lh.length + data.length;
  }
  const cdSize = centrals.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(10, centrals.length, true); ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, eocd];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let p = 0;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
}

describe('xlsx reader', () => {
  const inflate = (d: Uint8Array) => new Uint8Array(inflateRawSync(d));
  const book = zip({
    'xl/sharedStrings.xml': '<sst><si><t>Job Name</t></si><si><t>Contract</t></si><si><r><t>Okafor </t></r><r><t>&amp; Sons</t></r></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="3"><c r="A3" t="s"><v>2</v></c><c r="C3"><v>14850.5</v></c></row></sheetData></worksheet>',
  });
  it('reads shared strings, rich text, numbers and keeps row positions', () => {
    expect(readXlsxGrid(book, inflate)).toEqual([['Job Name', 'Contract'], [], ['Okafor & Sons', '', '14850.5']]);
  });
  it('a broken file is [] and a friendly parse error, never a throw', () => {
    expect(readXlsxGrid(new Uint8Array([1, 2, 3]), inflate)).toEqual([]);
    const r = gridFromUpload('jobs.xlsx', null, new Uint8Array([1, 2, 3]), inflate);
    expect(Array.isArray(r)).toBe(false);
  });
});
