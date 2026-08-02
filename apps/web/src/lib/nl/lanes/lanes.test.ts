import { describe, it, expect, vi } from 'vitest';
import { extractBillDraft, validateBillExtract } from './bill';
import { extractInvoiceDraft, validateInvoiceExtract } from './invoice';
import { extractCategorize, validateCategorizeExtract } from './categorize';
import { toCents, parseLooseJson } from './extract';

const TODAY = '2026-08-01';

describe('extract helpers', () => {
  it('toCents treats a decimal string as dollars and an integer as cents', () => {
    expect(toCents('1200.00')).toBe(120000);
    expect(toCents(120000)).toBe(120000);
    expect(toCents('$1,200.50')).toBe(120050);
    expect(toCents('')).toBeNull();
    expect(toCents('abc')).toBeNull();
  });
  it('parseLooseJson strips fences and trailing prose', () => {
    expect(parseLooseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseLooseJson('here you go {"a":2} thanks')).toEqual({ a: 2 });
    expect(parseLooseJson('not json')).toBeNull();
  });
});

describe('P3 bill extractor', () => {
  it('drafts a bill from a full instruction (reuses /api/bills/create on confirm)', async () => {
    const call = vi.fn(async () =>
      JSON.stringify({ vendorName: 'Acme', amountCents: 120000, billDate: '2026-08-01', dueDate: '2026-08-08', lineDescription: 'supplies', accountHint: null, memo: null, clarifyingQuestion: null, confidence: 0.9 }),
    );
    const r = await extractBillDraft('enter a $1,200 bill from Acme due next Friday', TODAY, call);
    expect(call).toHaveBeenCalledOnce();
    expect(r.draft?.vendorName).toBe('Acme');
    expect(r.draft?.amountCents).toBe(120000);
    expect(r.draft?.dueDate).toBe('2026-08-08');
    expect(r.clarifyingQuestion).toBeNull();
  });

  it('clarifies (no draft) when the amount is missing — clarify-before-book', () => {
    const r = validateBillExtract({ vendorName: 'Acme', amountCents: null, clarifyingQuestion: null }, TODAY);
    expect(r.draft).toBeNull();
    expect(r.clarifyingQuestion).toMatch(/amount/i);
  });

  it('clarifies when the vendor is missing', () => {
    const r = validateBillExtract({ vendorName: null, amountCents: 5000 }, TODAY);
    expect(r.draft).toBeNull();
    expect(r.clarifyingQuestion).toMatch(/vendor/i);
  });

  it('defaults the bill date to today when only a due date is given', () => {
    const r = validateBillExtract({ vendorName: 'Acme', amountCents: 5000, dueDate: '2026-09-01' }, TODAY);
    expect(r.draft?.billDate).toBe(TODAY);
  });
});

describe('P4 invoice extractor', () => {
  it('drafts an invoice (5k => 500000 cents) for /api/invoices on confirm', async () => {
    const call = vi.fn(async () =>
      JSON.stringify({ customerName: 'Coho', amountCents: 500000, invoiceDate: '2026-08-01', dueDate: null, lineDescription: 'June retainer', accountHint: null, memo: null, clarifyingQuestion: null, confidence: 0.88 }),
    );
    const r = await extractInvoiceDraft('invoice Coho $5k for June retainer', TODAY, call);
    expect(r.draft?.customerName).toBe('Coho');
    expect(r.draft?.amountCents).toBe(500000);
    expect(r.draft?.lineDescription).toBe('June retainer');
  });

  it('clarifies when the customer is missing', () => {
    const r = validateInvoiceExtract({ customerName: null, amountCents: 500000 }, TODAY);
    expect(r.draft).toBeNull();
    expect(r.clarifyingQuestion).toMatch(/customer/i);
  });

  it('fails closed to a clarify when the model output is unparseable', () => {
    const r = validateInvoiceExtract(null, TODAY);
    expect(r.draft).toBeNull();
    expect(r.clarifyingQuestion).toBeTruthy();
  });
});

describe('P2 categorize extractor', () => {
  it('extracts vendor + account + limit ("last 5")', async () => {
    const call = vi.fn(async () =>
      JSON.stringify({ vendorQuery: 'Home Depot', accountHint: 'job materials', limit: 5, clarifyingQuestion: null, confidence: 0.9 }),
    );
    const r = await extractCategorize('code the last 5 Home Depot charges to job materials', call);
    expect(r.draft?.vendorQuery).toBe('Home Depot');
    expect(r.draft?.accountHint).toBe('job materials');
    expect(r.draft?.limit).toBe(5);
  });

  it('defaults the limit and clamps it to 1..50', () => {
    expect(validateCategorizeExtract({ vendorQuery: 'Shell' }).draft?.limit).toBe(10);
    expect(validateCategorizeExtract({ vendorQuery: 'Shell', limit: 999 }).draft?.limit).toBe(50);
  });

  it('clarifies when no merchant is identifiable', () => {
    const r = validateCategorizeExtract({ vendorQuery: null, clarifyingQuestion: null });
    expect(r.draft).toBeNull();
    expect(r.clarifyingQuestion).toMatch(/merchant|vendor/i);
  });
});
