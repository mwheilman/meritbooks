import { describe, it, expect } from 'vitest';
import { buildDisbursementBatch, type DisbursementItemInput } from './disbursement-batch';
import {
  toBillPayCsv,
  buildNachaFile,
  type RemittanceDetail,
  type NachaConfig,
  type NachaVendorInstruction,
} from './disbursement-export';

function item(o: Partial<DisbursementItemInput>): DisbursementItemInput {
  return {
    approvalId: 'a1',
    billId: '11111111-2222-3333-4444-555555555555',
    vendorId: 'v1',
    vendorName: 'Acme Supply',
    invoiceRef: 'INV-100',
    amountCents: 150_099,
    paymentDate: '2026-08-10',
    method: 'ACH',
    locationId: 'loc1',
    preparedBy: 'u1',
    ...o,
  };
}

const NACHA_CONFIG: NachaConfig = {
  immediateDestination: '021000021',
  immediateOrigin: '1234567890',
  destinationName: 'BIG BANK',
  originName: 'MERIT MGMT',
  companyName: 'MERIT MGMT',
  companyId: '1123456789',
  effectiveDate: '2026-08-12',
  now: new Date('2026-08-10T14:30:00Z'),
};

describe('toBillPayCsv', () => {
  it('emits a header, one row per line, and a TOTAL control row', () => {
    const batch = buildDisbursementBatch([
      item({ approvalId: 'a1', vendorId: 'v1', vendorName: 'Acme', amountCents: 100_000, invoiceRef: 'A1' }),
      item({ approvalId: 'a2', vendorId: 'v2', vendorName: 'Beta', amountCents: 50_050, invoiceRef: 'B1', method: 'CHECK' }),
    ]);
    const remit = new Map<string, RemittanceDetail>([
      ['v1', { vendorId: 'v1', addressLine1: '1 Main St', addressLine2: null, city: 'Des Moines', state: 'IA', zip: '50301', email: 'ap@acme.test' }],
    ]);
    const csv = toBillPayCsv(batch, remit);
    const rows = csv.trim().split('\r\n');
    expect(rows[0]).toContain('Payment Date');
    expect(rows).toHaveLength(4); // header + 2 lines + TOTAL
    expect(rows[rows.length - 1]).toContain('TOTAL');
    expect(csv).toContain('1000.00');
    expect(csv).toContain('500.50');
    expect(csv).toContain('Des Moines');
  });

  it('escapes commas and quotes in vendor names', () => {
    const batch = buildDisbursementBatch([
      item({ approvalId: 'a1', vendorName: 'Smith, Jones "Co"', invoiceRef: 'X1' }),
    ]);
    const csv = toBillPayCsv(batch, new Map());
    expect(csv).toContain('"Smith, Jones ""Co"""');
  });
});

describe('buildNachaFile', () => {
  it('produces 94-char records blocked to a multiple of 10', () => {
    const batch = buildDisbursementBatch([
      item({ approvalId: 'a1', vendorId: 'v1', amountCents: 100_000 }),
      item({ approvalId: 'a2', vendorId: 'v2', vendorName: 'Beta', amountCents: 250_000, invoiceRef: 'B1' }),
    ]);
    const instr = new Map<string, NachaVendorInstruction>([
      ['v1', { vendorId: 'v1', routingNumber: '021000021', accountNumber: '123456789', accountType: 'checking' }],
      ['v2', { vendorId: 'v2', routingNumber: '011401533', accountNumber: '987654321', accountType: 'savings' }],
    ]);
    const res = buildNachaFile(batch, NACHA_CONFIG, instr);
    const recs = res.text.trimEnd().split('\n');
    for (const r of recs) expect(r).toHaveLength(94);
    expect(recs.length % 10).toBe(0);
    expect(recs[0][0]).toBe('1'); // file header
    expect(recs[1][0]).toBe('5'); // batch header
    expect(recs[2][0]).toBe('6'); // entry detail
    expect(res.entryCount).toBe(2);
    expect(res.totalCents).toBe(350_000);
    expect(res.warnings).toHaveLength(0);
  });

  it('warns and uses placeholders when full bank detail is missing', () => {
    const batch = buildDisbursementBatch([item({ approvalId: 'a1', vendorId: 'v1', amountCents: 100_000 })]);
    const res = buildNachaFile(batch, NACHA_CONFIG, new Map());
    expect(res.warnings.join(' ')).toMatch(/PLACEHOLDER/);
    const recs = res.text.trimEnd().split('\n');
    for (const r of recs) expect(r).toHaveLength(94);
  });

  it('excludes CHECK-method lines and reports them', () => {
    const batch = buildDisbursementBatch([
      item({ approvalId: 'a1', vendorId: 'v1', amountCents: 100_000, method: 'ACH' }),
      item({ approvalId: 'a2', vendorId: 'v2', vendorName: 'Beta', amountCents: 50_000, method: 'CHECK', invoiceRef: 'B1' }),
    ]);
    const instr = new Map<string, NachaVendorInstruction>([
      ['v1', { vendorId: 'v1', routingNumber: '021000021', accountNumber: '123456789' }],
    ]);
    const res = buildNachaFile(batch, NACHA_CONFIG, instr);
    expect(res.entryCount).toBe(1);
    expect(res.totalCents).toBe(100_000);
    expect(res.warnings.join(' ')).toMatch(/CHECK-method/);
  });
});
