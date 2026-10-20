import { describe, expect, it } from 'vitest';
import { extractJson, normalizeDealRecap, normalizeForKind, normalizeLenderStatement, normalizeOemStatement, normalizePrograms, normalizeUnitList } from './ai-normalize';
import { assembleLenderStatement, lenderHeaderFrom } from './statements';

describe('A1 lender statement normalizer', () => {
  const raw = {
    statement: { kind: 'audit', statement_date: '2026-09-30', totals: { principal: 15000.5, interest: 12.34, fees: null, line_count: 2 } },
    lines: [
      { invoice_number: 'A1', serial_number: 'S1', current_balance: 10000.25, original_amount: '12,000.00', status_code: 'SAU', confidence: 0.97 },
      { invoice_number: 'A2', current_balance: '5000.25', interest: 12.34, confidence: 0.99, days: 41 },
    ],
    document_note: null,
  };
  it('canonicalizes amounts/dates and keeps the header', () => {
    const p = normalizeLenderStatement(raw, 'LENDER_STATEMENT');
    expect(p.header).toMatchObject({ statementKind: 'AUDIT', statementDate: '2026-09-30', footerPrincipal: '15000.50', footerInterest: '12.34', footerFees: '', footerLineCount: '2' });
    expect(p.rows[0].cells).toMatchObject({ lenderInvoiceNumber: 'A1', currentCents: '10000.25', originalCents: '12000.00', lenderCode: 'SAU' });
    expect(p.rows[1].cells.days).toBe('41');
    expect(p.rows.every((r) => !r.lowConfidence)).toBe(true);
    expect(p.confidence).toBeCloseTo(0.98, 2);
  });
  it('the normalized proposal foots through the same assembly as a spreadsheet', () => {
    const p = normalizeLenderStatement(raw, 'LENDER_STATEMENT');
    const a = assembleLenderStatement(lenderHeaderFrom(p.header, 'STATEMENT'), p.rows.map((r) => r.cells), { kind: 'LENDER_STATEMENT', importBatchId: null, lineId: '11111111-1111-4111-8111-111111111111' });
    expect(a.ok).toBe(true);
    expect(a.body?.footer.principalCents).toBe(1_500_050);
  });
  it('never guesses: bad / missing values are blank and flagged', () => {
    const p = normalizeLenderStatement({ statement: { statement_date: 'sometime' }, lines: [{ current_balance: 'lots', confidence: 0.99 }, { invoice_number: 'X', current_balance: 5, confidence: 0.3 }, 'junk', null] }, 'LENDER_AUDIT');
    expect(p.header.statementKind).toBe('AUDIT');
    expect(p.header.statementDate).toBe('');
    expect(p.header.footerPrincipal).toBe('');
    expect(p.rows).toHaveLength(2);
    expect(p.rows[0].cells.currentCents).toBe('');
    expect(p.rows[0].lowConfidence).toBe(true);
    expect(p.rows[0].missing).toEqual(expect.arrayContaining(['currentCents', 'lenderInvoiceNumber']));
    expect(p.rows[1].lowConfidence).toBe(true); // confidence 0.3
  });
  it('malformed JSON shapes yield zero rows, never a throw', () => {
    expect(normalizeLenderStatement(null, 'LENDER_STATEMENT').rows).toEqual([]);
    expect(normalizeLenderStatement({ lines: 'nope' }, 'LENDER_STATEMENT').rows).toEqual([]);
    expect(normalizeOemStatement(42).rows).toEqual([]);
  });
});

describe('A2 OEM statement normalizer', () => {
  it('maps line types and keeps signs', () => {
    const p = normalizeOemStatement({
      document: { type: 'credit_memo', statement_date: '2026-09-30', total: -15.5 },
      lines: [
        { line_type: 'WARRANTY_CREDIT', reference: 'C1', amount: 20, confidence: 0.9 },
        { line_type: 'chargeback', amount: -35.5, confidence: 0.9 },
        { line_type: 'gibberish', amount: 1, confidence: 0.9 },
      ],
    });
    expect(p.header).toMatchObject({ documentType: 'CREDIT_MEMO', footerTotal: '-15.50' });
    expect(p.rows.map((r) => r.cells.lineType)).toEqual(['WARRANTY_CREDIT', 'DEBIT', '']);
    expect(p.rows[1].cells.amountCents).toBe('-35.50');
    expect(p.rows[2].lowConfidence).toBe(true);
  });
});

describe('A4 deal recap normalizer', () => {
  it('drafts a sale + trade and always flags the trade values for review', () => {
    const p = normalizeDealRecap({ deals: [{ deal_number: 'D-9', sale_date: '09/15/2026', unit_serial: 'SN1', customer_name: 'Jane', sale_price: 15000, trade: { serial_number: 'T1', allowance: 3000, acv: null }, confidence: 0.95 }] });
    const r = p.rows[0];
    expect(r.cells).toMatchObject({ externalDealRef: 'D-9', saleDate: '2026-09-15', salePriceCents: '15000.00', tradeSerial: 'T1', tradeAllowanceCents: '3000.00', tradeAcvCents: '' });
    expect(r.alwaysReview).toEqual(['tradeAllowanceCents']);
    expect(r.lowConfidence).toBe(false);
  });
});

describe('unit list + programs + dispatch', () => {
  it('units', () => {
    const p = normalizeUnitList({ units: [{ serial_number: 'S1', condition: 'used', model_year: '2024', dealer_cost: 9999.99, confidence: 0.8 }] }, 'UNITS');
    expect(p.rows[0].cells).toMatchObject({ serialNumber: 'S1', condition: 'USED', modelYear: '2024', dmsInvoiceCostCents: '9999.99' });
    const o = normalizeUnitList({ units: [{ serial_number: 'S1', dealer_cost: 1 }] }, 'OPENING');
    expect(o.rows[0].cells.dmsInvoiceCostCents).toBeUndefined();
  });
  it('programs keep treatment blank unless a valid code', () => {
    const p = normalizePrograms({ programs: [{ name: 'Fall', program_type: 'dealer cash', treatment: null, amount_per_unit: 250, paid_direct: true, confidence: 0.9 }] });
    expect(p.rows[0].cells).toMatchObject({ name: 'Fall', programType: 'DEALER_REBATE', treatment: '', amountCents: '250.00', paidDirect: 'yes' });
  });
  it('warranty has no AI reader', () => {
    expect(normalizeForKind('WARRANTY', {})).toBeNull();
  });
  it('extracts JSON from fenced or chatty replies', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here you go: {"a":2} hope it helps')).toEqual({ a: 2 });
    expect(extractJson('no json')).toBeNull();
  });
});
