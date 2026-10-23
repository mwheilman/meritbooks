/**
 * Check-run + alignment PDFs render (FPB-check-processing §4.1): payee, amount in words,
 * protected numeral, check number, VOID AFTER, stub lines; the alignment sheet says it is
 * not a check. The MICR line is vector (no text), so it never leaks the numbers as text.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToBuffer } from '@react-pdf/renderer';
import { pdfText } from '@/test/pdf-text';
import { AlignmentPdf, CheckRunPdf } from './check-pdf';
import { renderCheck, type CheckStockSetup } from './check-doc';
import type { CheckLayout } from './layout';

const setup = (layout: CheckLayout): CheckStockSetup => ({
  layout, offsetXPt: 1.5, offsetYPt: -1, payerName: 'Heritage Interiors LLC', payerAddress: '9 Elm St\nAmes, IA 50010', logo: null,
  bankName: 'First Bank', bankAddress: 'Des Moines, IA', bankFraction: '12-3456/1234', routing: '021000021', account: '987654321',
  auxDigits: 6, voidAfterDays: 90, signature: null, signature2: null, secondSignatureOverCents: 500_000,
});

const check = (n: number, amount: number) => ({
  checkNumber: n, checkDate: '2026-10-23', payeeName: 'Acme Supply', payeeAddress: '1 Main St\nDes Moines, IA 50309', amountCents: amount, memo: 'Inv A-100',
  stubLines: [{ date: '2026-10-01', ref: 'A-100', billAmountCents: amount, discountCents: 0, paidCents: amount }],
});

describe('check PDFs', () => {
  it.each(['VOUCHER_TOP', 'VOUCHER_MIDDLE', 'VOUCHER_BOTTOM', 'THREE_UP'] as CheckLayout[])('renders %s', async (layout) => {
    const s = setup(layout);
    const checks = [renderCheck(check(1043, 1_234_56), s), renderCheck(check(1044, 600_000), s)];
    const big = await renderToBuffer(React.createElement(CheckRunPdf, { checks: [checks[1]], setup: s }) as Parameters<typeof renderToBuffer>[0]);
    const bigText = pdfText(big).replace(/\s+/g, ' ');
    expect(bigText).toContain('Six Thousand and 00/100');
    expect(bigText).toContain('TWO SIGNATURES REQUIRED'); // over the $5,000 threshold
    const both = await renderToBuffer(React.createElement(CheckRunPdf, { checks, setup: s }) as Parameters<typeof renderToBuffer>[0]);
    expect(both.subarray(0, 5).toString()).toBe('%PDF-');
    const pages = (both.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    expect(pages).toBe(layout === 'THREE_UP' ? 1 : 2);
    const buf = await renderToBuffer(React.createElement(CheckRunPdf, { checks: [checks[0]], setup: s }) as Parameters<typeof renderToBuffer>[0]);
    const text = pdfText(buf).replace(/\s+/g, ' ');
    expect(text).toContain('Acme Supply');
    expect(text).toContain('One Thousand Two Hundred Thirty-Four and 56/100');
    expect(text).toContain('******1,234.56');
    expect(text).toContain('1043');
    expect(text).toContain('VOID AFTER 90 DAYS');
    expect(text).not.toContain('987654321');
    if (layout !== 'THREE_UP') expect(text).toContain('A-100');
  }, 60_000);

  it('renders the alignment test page', async () => {
    const buf = await renderToBuffer(React.createElement(AlignmentPdf, { layout: 'VOUCHER_TOP', offsetXPt: 0, offsetYPt: 0, accountLabel: 'Operating ****6789' }) as Parameters<typeof renderToBuffer>[0]);
    const text = pdfText(buf).replace(/\s+/g, ' ');
    expect(text).toContain('ALIGNMENT TEST');
    expect(text).toContain('MICR CLEAR BAND');
  }, 60_000);
});
