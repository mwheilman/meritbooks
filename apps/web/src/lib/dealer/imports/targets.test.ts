import { describe, expect, it } from 'vitest';
import { matchEnum, validateRow, validateRows, type Cells, type ImportContext, type Resolution } from './targets';
import { fieldOf } from './fields';
import { assembleLenderStatement, assembleOemStatement, FOOTING_MESSAGE } from './statements';

const LINE = '11111111-1111-4111-8111-111111111111';
const OEM = '22222222-2222-4222-8222-222222222222';
const BATCH = '33333333-3333-4333-8333-333333333333';
const UNIT = '44444444-4444-4444-8444-444444444444';
const CUST = '55555555-5555-4555-8555-555555555555';
const PROG = '66666666-6666-4666-8666-666666666666';

const resolve: Resolution = { unitsBySerial: { SN100: UNIT }, customersByName: { JANEBUYER: CUST }, vendorsByName: { ACMEMOTORS: OEM } };
const ctx = (over: Partial<ImportContext> = {}): ImportContext => ({ kind: 'UNITS', importBatchId: BATCH, resolve, ...over });

describe('units', () => {
  it('a plain row becomes a unit body (source DMS, batch id)', () => {
    const r = validateRow('UNITS', { serialNumber: 'SN-1', model: 'X1', modelYear: '2026', condition: 'u', receivedDate: '9/1/2026', make: 'Acme Motors' }, ctx());
    expect(r.ok).toBe(true);
    if (!r.ok || r.plan.target !== 'unit') throw new Error('expected unit');
    expect(r.plan.body).toMatchObject({ serialNumber: 'SN-1', condition: 'USED', modelYear: 2026, receivedDate: '2026-09-01', source: 'DMS', importBatchId: BATCH, makeVendorId: OEM });
  });
  it('required serial and bad values give plain-English errors', () => {
    const r = validateRow('UNITS', { serialNumber: '', modelYear: 'abc', receivedDate: '2026-13-01' }, ctx());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual(expect.arrayContaining(['Serial number is required.']));
    expect(r.errors.some((e) => e.startsWith('Model year:'))).toBe(true);
    expect(r.errors.some((e) => e.startsWith('Received date:'))).toBe(true);
  });
  it('a row with a floored amount floors on the chosen line (viaImport + DMS cost)', () => {
    const r = validateRow('UNITS', { serialNumber: 'SN-2', principalCents: '$10,000.00', lenderInvoiceNumber: 'INV-9', flooredDate: '2026-09-02', dmsInvoiceCostCents: '10000' }, ctx({ lineId: LINE }));
    if (!r.ok || r.plan.target !== 'floor') throw new Error('expected floor');
    expect(r.plan.body).toMatchObject({ lineId: LINE, principalCents: 1_000_000, lenderInvoiceNumber: 'INV-9', viaImport: true, dmsInvoiceCostCents: 1_000_000, collateralType: 'WHOLE_GOOD' });
  });
  it('a floored amount without a line, or without an invoice #, is refused', () => {
    expect(validateRow('UNITS', { serialNumber: 'S', principalCents: '100' }, ctx()).ok).toBe(false);
    const r = validateRow('UNITS', { serialNumber: 'S', principalCents: '100', flooredDate: '2026-01-01' }, ctx({ lineId: LINE }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain('Lender invoice # is required to floor this unit.');
  });
  it('opening rows floor with opening (no GL) and owned units load as OPENING units', () => {
    const f = validateRow('OPENING', { serialNumber: 'S', principalCents: '900.00', lenderInvoiceNumber: 'I', flooredDate: '2026-01-01', interestAccruedThrough: '2026-09-30' }, ctx({ kind: 'OPENING', lineId: LINE }));
    if (!f.ok || f.plan.target !== 'floor') throw new Error('expected floor');
    expect(f.plan.body.opening).toEqual({ interestAccruedThrough: '2026-09-30' });
    expect(f.plan.body.viaImport).toBeUndefined();
    const u = validateRow('OPENING', { serialNumber: 'S2' }, ctx({ kind: 'OPENING' }));
    if (!u.ok || u.plan.target !== 'unit') throw new Error('expected unit');
    expect(u.plan.body.source).toBe('OPENING');
  });
  it('in-file duplicate serials are rejected', () => {
    const r = validateRows('UNITS', [{ serialNumber: 'A-1' }, { serialNumber: 'a1' }], ctx());
    expect(r.accepted).toBe(1);
    expect(r.rejected).toBe(1);
  });
});

describe('deals', () => {
  const base = { externalDealRef: 'D-1', saleDate: '2026-09-15', serialNumber: 'SN 100', customer: 'Jane Buyer', salePriceCents: '15,000.00' };
  it('resolves the unit + customer and posts as source DMS with a trade', () => {
    const r = validateRow('DEALS', { ...base, tradeSerial: 'T1', tradeAllowanceCents: '3000', tradeAcvCents: '2500' }, ctx({ kind: 'DEALS' }));
    if (!r.ok || r.plan.target !== 'sale') throw new Error('expected sale');
    expect(r.plan.body).toMatchObject({ unitId: UNIT, customerId: CUST, source: 'DMS', externalDealRef: 'D-1', salePriceCents: 1_500_000 });
    expect(r.plan.body.trade).toMatchObject({ serialNumber: 'T1', allowanceCents: 300_000, acvCents: 250_000 });
    expect(r.warnings.join(' ')).toMatch(/approval/);
  });
  it('unknown unit / customer, missing trade ACV and a rebate without program are refused', () => {
    const r = validateRow('DEALS', { ...base, serialNumber: 'NOPE', customer: 'Nobody', tradeSerial: 'T1', tradeAllowanceCents: '1', retailRebateCents: '500' }, ctx({ kind: 'DEALS' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(' ')).toMatch(/No unit with serial/);
    expect(r.errors.join(' ')).toMatch(/No customer named/);
    expect(r.errors.join(' ')).toMatch(/Trade ACV is required/);
    expect(r.errors.join(' ')).toMatch(/retail rebate/);
    const ok = validateRow('DEALS', { ...base, retailRebateCents: '500' }, ctx({ kind: 'DEALS', retailRebateProgramId: PROG }));
    if (!ok.ok || ok.plan.target !== 'sale') throw new Error('expected sale');
    expect(ok.plan.body.retailRebateProgramId).toBe(PROG);
  });
  it('without resolution the row waits for the Books check', () => {
    const r = validateRow('DEALS', base, { kind: 'DEALS', importBatchId: BATCH });
    expect(r.ok).toBe(false);
  });
});

describe('warranty', () => {
  it('builds a claim and checks the total when mapped', () => {
    const cells = { oemClaimNumber: 'C-1', laborHours: '2', laborRateCents: '95.00', partsCostCents: '80.00', partsMarkupBps: '30%', claimedTotalCents: '294.00' };
    const r = validateRow('WARRANTY', cells, ctx({ kind: 'WARRANTY', oemVendorId: OEM }));
    if (!r.ok || r.plan.target !== 'warranty') throw new Error('expected warranty');
    expect(r.plan.body).toMatchObject({ oemVendorId: OEM, laborHours: '2.00', laborRateCents: 9500, partsCostCents: 8000, partsMarkupBps: 3000 });
    const bad = validateRow('WARRANTY', { ...cells, claimedTotalCents: '300.00' }, ctx({ kind: 'WARRANTY', oemVendorId: OEM }));
    expect(bad.ok).toBe(false);
  });
  it('needs a manufacturer and an identifying reference', () => {
    const r = validateRow('WARRANTY', { laborHours: '1', laborRateCents: '1', partsCostCents: '0' }, ctx({ kind: 'WARRANTY' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBe(2);
  });
});

describe('statements (AC11)', () => {
  const header = { statementKind: 'STATEMENT' as const, statementDate: '9/30/2026', footerPrincipal: '150.00', footerInterest: '', footerFees: '', footerLineCount: '2' };
  const rows: Cells[] = [{ lenderInvoiceNumber: 'A1', currentCents: '100.00' }, { serialNumber: 'S2', currentCents: '50.00' }];
  it('a footing statement assembles into the D1 body', () => {
    const a = assembleLenderStatement(header, rows, { kind: 'LENDER_STATEMENT', importBatchId: BATCH, lineId: LINE });
    expect(a.ok).toBe(true);
    expect(a.body).toMatchObject({ lineId: LINE, kind: 'STATEMENT', statementDate: '2026-09-30', footer: { principalCents: 15_000, lineCount: 2 } });
    expect(a.body?.lines).toHaveLength(2);
  });
  it('lines that don’t add up are rejected with the plain-English message', () => {
    const a = assembleLenderStatement({ ...header, footerPrincipal: '151.00' }, rows, { kind: 'LENDER_STATEMENT', importBatchId: BATCH, lineId: LINE });
    expect(a.ok).toBe(false);
    expect(a.body).toBeNull();
    expect(a.problems.join(' ')).toContain(FOOTING_MESSAGE);
  });
  it('a line without an invoice # or serial is a row problem', () => {
    const a = assembleLenderStatement(header, [{ currentCents: '150.00' }], { kind: 'LENDER_STATEMENT', importBatchId: BATCH, lineId: LINE });
    expect(a.ok).toBe(false);
    expect(a.rows.rejected).toBe(1);
  });
  it('OEM statement: types from words, signed amounts, credit/debit columns', () => {
    const a = assembleOemStatement({ statementDate: '2026-09-30', footerTotal: '250.00' }, [
      { lineType: 'Warranty', reference: 'C-1', amountCents: '270.00' },
      { lineType: 'chargeback', creditCents: '', debitCents: '20.00' },
    ], { kind: 'OEM_STATEMENT', importBatchId: BATCH, oemVendorId: OEM });
    expect(a.ok).toBe(true);
    expect(a.body?.lines.map((l) => [l.lineType, l.amountCents])).toEqual([['WARRANTY_CREDIT', 27_000], ['DEBIT', -2_000]]);
    const off = assembleOemStatement({ statementDate: '2026-09-30', footerTotal: '270.00' }, [{ lineType: 'Warranty', amountCents: '250.00' }], { kind: 'OEM_STATEMENT', importBatchId: BATCH, oemVendorId: OEM });
    expect(off.ok).toBe(false);
  });
  it('unknown OEM line type needs a default', () => {
    const r = validateRow('OEM_STATEMENT', { lineType: 'mystery', amountCents: '1' }, ctx({ kind: 'OEM_STATEMENT' }));
    expect(r.ok).toBe(false);
    const d = validateRow('OEM_STATEMENT', { amountCents: '1' }, ctx({ kind: 'OEM_STATEMENT', defaultOemLineType: 'OTHER' }));
    expect(d.ok).toBe(true);
  });
});

describe('programs', () => {
  it('drafts a program with rules', () => {
    const r = validateRow('PROGRAMS', { name: 'Fall cash', programType: 'retail rebate', amountCents: '500', startDate: '2026-09-01', endDate: '2026-12-31' }, ctx({ kind: 'PROGRAMS', oemVendorId: OEM }));
    if (!r.ok || r.plan.target !== 'program') throw new Error('expected program');
    expect(r.plan.body).toMatchObject({ programType: 'RETAIL_REBATE', rules: { amountCents: 50_000 } });
  });
  it('end before start is refused', () => {
    expect(validateRow('PROGRAMS', { name: 'x', programType: 'OTHER', startDate: '2026-09-01', endDate: '2026-08-01' }, ctx({ kind: 'PROGRAMS', oemVendorId: OEM })).ok).toBe(false);
  });
});

describe('matchEnum', () => {
  it('matches codes, labels and synonyms', () => {
    const opts = fieldOf('UNITS', 'condition')!.options!;
    expect(matchEnum('NEW', opts)).toBe('NEW');
    expect(matchEnum('Pre-Owned', opts)).toBe('USED');
    expect(matchEnum('rental fleet unit', opts)).toBe('RENTAL');
    expect(matchEnum('zzz', opts)).toBeNull();
  });
});
