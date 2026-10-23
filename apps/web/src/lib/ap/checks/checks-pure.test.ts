/**
 * Check processing — pure units (FPB-check-processing AC-2, AC-3, AC-4, AC-11, AC-13, AC-15).
 */
import { describe, it, expect } from 'vitest';
import { amountToWords, dollarsToWords, protectedAmount, wordsLine, CheckAmountError, MAX_CHECK_CENTS } from './amount-words';
import { composeMicrLine, isValidRoutingNumber, maskLast4, MicrError, positionCellIn, validateMicrInputs } from './micr';
import {
  BOFA_STYLE_FIXED,
  CHASE_STYLE_FIXED,
  buildPositivePayFile,
  selectForPositivePay,
  toRecords,
  validateFixedMapping,
  PositivePayError,
  type RegisterCheckForPp,
} from './positive-pay';
import { csvEscape, findGaps, formatRanges, isStale, isPastVoidDate, parseCheckNumber } from './register';
import { parseCorrelation, spoilProblem, vendorAddress } from './print-service';
import { confirmProblem, holdFor, thresholdChanges } from './stock-security';
import { getCheckMailProvider, CheckMailNotConfiguredError } from '@/lib/ap/check-mail/provider';
import { pageBands, paginate } from '@/lib/ap/check-print/layout';
import { glyphRectsPt, E13B_GLYPHS } from '@/lib/ap/check-print/e13b';
import { renderCheck, signaturesRequired, type CheckStockSetup } from '@/lib/ap/check-print/check-doc';

describe('AC-2 amount in words', () => {
  it.each([
    [5, 'Zero and 05/100'],
    [100, 'One and 00/100'],
    [1_234_56, 'One Thousand Two Hundred Thirty-Four and 56/100'],
    [1_000_000_00, 'One Million and 00/100'],
    [1_000_001_01, 'One Million One and 01/100'],
    [21_00, 'Twenty-One and 00/100'],
    [1_900_00, 'One Thousand Nine Hundred and 00/100'],
    [100_015_00, 'One Hundred Thousand Fifteen and 00/100'],
    [12_345_678_90, 'Twelve Million Three Hundred Forty-Five Thousand Six Hundred Seventy-Eight and 90/100'],
    [MAX_CHECK_CENTS, 'Ninety-Nine Million Nine Hundred Ninety-Nine Thousand Nine Hundred Ninety-Nine and 99/100'],
  ])('%i cents → %s', (cents, words) => {
    expect(amountToWords(cents)).toBe(words);
  });

  it('refuses zero, negative, fractional and over-limit amounts', () => {
    for (const bad of [0, -100, 10.5, MAX_CHECK_CENTS + 1]) expect(() => amountToWords(bad)).toThrow(CheckAmountError);
  });

  it('teens and tens', () => {
    expect(dollarsToWords(13)).toBe('Thirteen');
    expect(dollarsToWords(90)).toBe('Ninety');
    expect(dollarsToWords(110)).toBe('One Hundred Ten');
  });

  it('fills the written line with asterisks', () => {
    const line = wordsLine(1_234_56, 80);
    expect(line).toHaveLength(80);
    expect(line.startsWith('One Thousand Two Hundred Thirty-Four and 56/100 *')).toBe(true);
  });
});

describe('AC-3 protected numeral', () => {
  it('pads with asterisks to a fixed width', () => {
    expect(protectedAmount(1_234_56)).toBe('******1,234.56');
    expect(protectedAmount(1_234_56)).toHaveLength(14);
    expect(protectedAmount(7)).toBe('**********0.07');
    expect(protectedAmount(MAX_CHECK_CENTS)).toBe('*99,999,999.99');
  });
});

describe('AC-4 MICR line', () => {
  it('validates the ABA checksum', () => {
    expect(isValidRoutingNumber('021000021')).toBe(true);
    expect(isValidRoutingNumber('011000015')).toBe(true);
    expect(isValidRoutingNumber('021000022')).toBe(false);
    expect(isValidRoutingNumber('12345678')).toBe(false);
    expect(validateMicrInputs('021000021', '123')).toMatch(/4 to 17/);
    expect(validateMicrInputs('021000021', '1'.repeat(18))).toMatch(/4 to 17/);
  });

  it('places aux on-us, transit and on-us at the X9.13 positions', () => {
    const m = composeMicrLine({ checkNumber: 1043, routing: '021000021', account: '123456789' });
    const at = (p: number) => m.cells.find((c) => c.position === p)?.char;
    // on-us symbol at 14, account to its left (last digit at 15)
    expect(at(14)).toBe('U');
    expect(at(15)).toBe('9');
    expect(at(23)).toBe('1');
    // transit 33..43: ⑆ 0 2 1 0 0 0 0 2 1 ⑆ read left→right from 43 down to 33
    expect(at(43)).toBe('T');
    expect(at(33)).toBe('T');
    expect([42, 41, 40, 39, 38, 37, 36, 35, 34].map(at).join('')).toBe('021000021');
    // aux on-us: ⑈001043⑈ with the right ⑈ at 45
    expect(at(45)).toBe('U');
    expect([51, 50, 49, 48, 47, 46].map(at).join('')).toBe('001043');
    expect(at(52)).toBe('U');
    // amount field and separators are blank
    for (const p of [1, 5, 12, 13, 32, 44]) expect(at(p)).toBeUndefined();
    expect(m.display).toBe('⑈001043⑈ ⑆021000021⑆         123456789⑈             ');
  });

  it('honours the aux-digits setting and refuses bad input', () => {
    const m = composeMicrLine({ checkNumber: 7, routing: '021000021', account: '0000', auxDigits: 8 });
    expect(m.text.startsWith('U00000007U')).toBe(true);
    expect(() => composeMicrLine({ checkNumber: 1, routing: '021000022', account: '1234' })).toThrow(MicrError);
    expect(() => composeMicrLine({ checkNumber: 100_000_000, routing: '021000021', account: '1234' })).toThrow(MicrError);
    expect(() => composeMicrLine({ checkNumber: 1, routing: '021000021', account: '12' })).toThrow(MicrError);
  });

  it('position 1 ends 5/16" from the right edge at 1/8" pitch', () => {
    expect(positionCellIn(1, 8.5)).toEqual({ left: 8.5 - 0.3125 - 0.125, right: 8.5 - 0.3125 });
    expect(positionCellIn(9, 8.5).right).toBeCloseTo(8.5 - 0.3125 - 1, 10);
  });

  it('masks to last 4', () => {
    expect(maskLast4('021000021')).toBe('*****0021');
    expect(maskLast4('123456789012')).toBe('********9012');
  });

  it('every glyph stays inside its 0.125" cell and 0.117" height', () => {
    for (const ch of Object.keys(E13B_GLYPHS) as Array<keyof typeof E13B_GLYPHS>) {
      const rects = glyphRectsPt(ch, 0, 100);
      for (const r of rects) {
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w).toBeLessThanOrEqual(9.0001);
        expect(r.y).toBeGreaterThanOrEqual(100 - 0.117 * 72 - 0.0001);
        expect(r.y + r.h).toBeLessThanOrEqual(100.0001);
      }
    }
  });
});

describe('check document', () => {
  const setup: CheckStockSetup = {
    layout: 'VOUCHER_TOP', offsetXPt: 0, offsetYPt: 0, payerName: 'Heritage Interiors', payerAddress: null, logo: null,
    bankName: 'First Bank', bankAddress: null, bankFraction: '12-3456/1234', routing: '021000021', account: '123456789',
    auxDigits: 6, voidAfterDays: 90, signature: { data: Buffer.from([0x89]), format: 'png' }, signature2: null, secondSignatureOverCents: 500_000,
  };
  it('requires two signatures above the threshold and truncates long stubs', () => {
    expect(signaturesRequired(500_000, 500_000)).toBe(1);
    expect(signaturesRequired(500_001, 500_000)).toBe(2);
    const lines = Array.from({ length: 15 }, (_, i) => ({ date: '2026-10-01', ref: `INV-${i}`, billAmountCents: 100, discountCents: 0, paidCents: 100 }));
    const r = renderCheck({ checkNumber: 1001, checkDate: '2026-10-23', payeeName: 'Acme', payeeAddress: null, amountCents: 600_000, memo: null, stubLines: lines }, setup);
    expect(r.signaturesRequired).toBe(2);
    expect(r.signaturesPrinted).toBe(1);
    expect(r.stubVisible).toHaveLength(11);
    expect(r.stubOverflow).toBe(4);
    expect(r.numeral).toBe('******6,000.00');
  });
  it('layouts: voucher = 1 check + 2 stubs; 3-up = 3 checks per page', () => {
    expect(pageBands('VOUCHER_MIDDLE').map((b) => b.kind)).toEqual(['stub', 'check', 'stub']);
    expect(pageBands('VOUCHER_BOTTOM').map((b) => b.kind)).toEqual(['stub', 'stub', 'check']);
    expect(pageBands('THREE_UP').every((b) => b.kind === 'check')).toBe(true);
    expect(pageBands('VOUCHER_TOP').reduce((s, b) => s + b.height, 0)).toBe(792);
    expect(paginate([1, 2, 3, 4], 'THREE_UP')).toEqual([[1, 2, 3], [4]]);
    expect(paginate([1, 2], 'VOUCHER_TOP')).toEqual([[1], [2]]);
  });
});

describe('AC-11 positive pay', () => {
  const checks: RegisterCheckForPp[] = [
    { id: 'a', checkNumber: 1001, checkDate: '2026-10-01', amountCents: 123_456, payeeName: 'Acme Supply, Inc.', status: 'ISSUED', voidedAt: null, issueExportId: 'old', voidExportId: null },
    { id: 'b', checkNumber: 1002, checkDate: '2026-10-02', amountCents: 50_00, payeeName: 'Bob’s Café', status: 'PRINTED', voidedAt: null, issueExportId: null, voidExportId: null },
    { id: 'c', checkNumber: 1003, checkDate: '2026-10-03', amountCents: 75_00, payeeName: 'Carl', status: 'VOIDED', voidedAt: '2026-10-05T10:00:00Z', issueExportId: 'old', voidExportId: null },
    { id: 'd', checkNumber: 1004, checkDate: '2026-10-03', amountCents: 9_00, payeeName: 'Dee', status: 'SPOILED', voidedAt: '2026-10-03T10:00:00Z', issueExportId: null, voidExportId: null },
    { id: 'e', checkNumber: 1005, checkDate: '2026-09-01', amountCents: 1_00, payeeName: 'Eve', status: 'VOIDED', voidedAt: '2026-09-02T10:00:00Z', issueExportId: 'old', voidExportId: 'old' },
  ];

  it('since-last picks new issues and new voids (spoiled = void only)', () => {
    const sel = selectForPositivePay(checks, 'SINCE_LAST');
    expect(sel.issues.map((c) => c.id)).toEqual(['b']);
    expect(sel.voids.map((c) => c.id)).toEqual(['c', 'd']);
  });

  it('range picks by issue date and void date', () => {
    const sel = selectForPositivePay(checks, 'RANGE', { from: '2026-10-01', through: '2026-10-31' });
    expect(sel.issues.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(sel.voids.map((c) => c.id)).toEqual(['c', 'd']);
  });

  const records = toRecords(selectForPositivePay(checks, 'SINCE_LAST'), '123456789', '021000021');

  it('generic CSV carries account, routing, number, date, amount, payee and I/V', () => {
    const f = buildPositivePayFile(records, 'GENERIC_CSV');
    const lines = f.content.trim().split('\r\n');
    expect(lines[0]).toBe('Account Number,Routing Number,Check Number,Issue Date,Amount,Payee Name,Void Indicator');
    expect(lines[1]).toBe('123456789,021000021,1002,10/02/2026,50.00,Bobs Cafe,I');
    expect(lines[2]).toBe('123456789,021000021,1003,10/03/2026,75.00,Carl,V');
    expect(lines[3]).toBe('123456789,021000021,1004,10/03/2026,9.00,Dee,V');
    expect(f.extension).toBe('csv');
  });

  it('Chase-style fixed width: exact 80-char records', () => {
    const f = buildPositivePayFile(records, 'CHASE_STYLE_FIXED');
    const lines = f.content.split('\r\n').filter(Boolean);
    expect(lines.every((l) => l.length === 80)).toBe(true);
    expect(lines[0].slice(0, 14)).toBe('00000123456789');
    expect(lines[0].slice(14, 24)).toBe('0000001002');
    expect(lines[0].slice(24, 34)).toBe('0000005000');
    expect(lines[0].slice(34, 42)).toBe('10022026');
    expect(lines[0][42]).toBe(' ');
    expect(lines[1][42]).toBe('V');
    expect(lines[0].slice(43).trimEnd()).toBe('Bobs Cafe');
  });

  it('BofA-style fixed width: exact 95-char records with issue/void codes', () => {
    const f = buildPositivePayFile(records, 'BOFA_STYLE_FIXED');
    const lines = f.content.split('\r\n').filter(Boolean);
    expect(lines.every((l) => l.length === 95)).toBe(true);
    expect(lines[0].slice(0, 13)).toBe('0000123456789');
    expect(lines[0].slice(23, 35)).toBe('000000005000');
    expect(lines[0].slice(35, 43)).toBe('20261002');
    expect(lines[0].slice(43, 45)).toBe('20');
    expect(lines[1].slice(43, 45)).toBe('26');
  });

  it('custom CSV mapping re-orders and renames columns', () => {
    const f = buildPositivePayFile(records.slice(0, 1), 'CUSTOM_CSV', {
      csv: {
        columns: [{ field: 'check_number', header: 'Serial' }, { field: 'amount', header: 'Amt' }, { field: 'record_code', header: 'Type' }, { field: 'constant', header: 'Bank', value: 'X1' }],
        includeHeader: true, dateFormat: 'YYYYMMDD', amountFormat: 'CENTS', issueCode: 'ISS', voidCode: 'VOID', delimiter: '|',
      },
    });
    expect(f.content).toBe('Serial|Amt|Type|Bank\r\n1002|5000|ISS|X1\r\n');
  });

  it('a number that does not fit its column is an error, never truncated', () => {
    const tiny = { ...CHASE_STYLE_FIXED, fields: CHASE_STYLE_FIXED.fields.map((f) => (f.field === 'account' ? { ...f, length: 4 } : f)) };
    expect(validateFixedMapping(tiny)).toBeNull();
    expect(() => buildPositivePayFile(records, 'CUSTOM_FIXED', { fixed: tiny })).toThrow(PositivePayError);
    expect(validateFixedMapping({ ...BOFA_STYLE_FIXED, fields: [...BOFA_STYLE_FIXED.fields, { field: 'filler', start: 5, length: 2, align: 'left', pad: ' ' }] })).toMatch(/overlap/);
    expect(() => buildPositivePayFile(records, 'CUSTOM_CSV', null)).toThrow(PositivePayError);
  });
});

describe('AC-13 register helpers', () => {
  it('stale after the threshold; past the printed void date', () => {
    expect(isStale('ISSUED', '2026-01-01', '2026-07-01', 180)).toBe(true);
    expect(isStale('ISSUED', '2026-06-01', '2026-07-01', 180)).toBe(false);
    expect(isStale('CLEARED', '2026-01-01', '2026-10-01', 180)).toBe(false);
    expect(isPastVoidDate('MAILED', '2026-06-01', '2026-10-01', 90)).toBe(true);
  });
  it('finds gaps minus declared skips', () => {
    expect(findGaps([1001, 1002, 1005, 1100, 1101], [{ fromNumber: 1006, toNumber: 1100 }]).missing).toEqual([1003, 1004]);
    expect(formatRanges([1003, 1004, 1010])).toBe('1003–1004, 1010');
    expect(findGaps([1001]).missing).toEqual([]);
  });
  it('parses check numbers from bank descriptions', () => {
    expect(parseCheckNumber('CHECK 1043')).toBe(1043);
    expect(parseCheckNumber('CHK #1043')).toBe(1043);
    expect(parseCheckNumber('Check No. 0001043 paid')).toBe(1043);
    expect(parseCheckNumber('CHECK PAID 1043')).toBe(1043);
    expect(parseCheckNumber('CHECKCARD 0921 AMAZON')).toBeNull();
    expect(parseCheckNumber('ACH VENDOR PMT')).toBeNull();
    expect(parseCheckNumber('anything', '001043')).toBe(1043);
  });
  it('neutralises formula-looking text in the register export', () => {
    expect(csvEscape('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvEscape('Acme, Inc.')).toBe('"Acme, Inc."');
    expect(csvEscape(1043)).toBe('1043');
  });
  it('parses release correlations', () => {
    const id = '0b5a1f9e-8a1c-4a66-9d0b-2f5f8f9a1c11';
    expect(parseCorrelation(`bill_payment:${id}`)).toEqual({ paymentId: id, handwritten: false });
    expect(parseCorrelation(`bill_payment:${id}|check:1042`)).toEqual({ paymentId: id, handwritten: true });
    expect(parseCorrelation('payroll:xyz')).toBeNull();
  });
  it('formats a vendor mailing address', () => {
    expect(vendorAddress({ id: 'v', name: 'A', display_name: null, address_line1: '1 Main St', address_line2: null, city: 'Des Moines', state: 'IA', zip: '50309' }))
      .toBe('1 Main St\nDes Moines, IA 50309');
  });
});

describe('AC-15 mail adapter', () => {
  it('is not configured and refuses to send', async () => {
    const p = getCheckMailProvider('org');
    expect(p.status().configured).toBe(false);
    expect(p.status().note).toMatch(/Not configured/);
    await expect(p.mail({} as never)).rejects.toBeInstanceOf(CheckMailNotConfiguredError);
  });
});

describe('security review M1 — spoilProblem', () => {
  const printedAt = '2026-10-20T10:00:00Z';
  const row = { check_number: 1042, status: 'PRINTED', printed_by: 'u_print', printed_at: printedAt };
  const at = (h: number) => new Date(new Date(printedAt).getTime() + h * 3600_000);
  it('allows only the printer, within 24 h, on a still-PRINTED check', () => {
    expect(spoilProblem(row, 'u_print', at(1))).toBeNull();
    expect(spoilProblem(row, 'u_print', at(24))).toBeNull();
    expect(spoilProblem(row, 'u_print', at(24.1))).toMatch(/more than 24 hours.*Void it instead/);
    expect(spoilProblem(row, 'u_other', at(1))).toMatch(/Only the person who printed check 1042/);
    for (const status of ['ISSUED', 'MAILED', 'CLEARED', 'VOIDED']) {
      expect(spoilProblem({ ...row, status }, 'u_print', at(1))).toMatch(/Void it instead/);
    }
  });
});

describe('security review M9 — stock security rules', () => {
  it('thresholdChanges: raised / lowered / removed count; first-time limits and no-ops do not', () => {
    const prev = { secondSignatureOverCents: 100_000, maxCheckCents: 500_000 };
    expect(thresholdChanges(null, { secondSignatureOverCents: null, maxCheckCents: null })).toEqual([]);
    expect(thresholdChanges(prev, prev)).toEqual([]);
    expect(thresholdChanges(prev, { secondSignatureOverCents: null, maxCheckCents: 500_000 }).map((c) => c.kind)).toEqual(['SECOND_SIGNATURE_THRESHOLD']);
    expect(thresholdChanges(prev, { secondSignatureOverCents: 50_000, maxCheckCents: 900_000 }).map((c) => c.kind)).toEqual(['SECOND_SIGNATURE_THRESHOLD', 'MAX_CHECK_AMOUNT']);
    expect(thresholdChanges(prev, { secondSignatureOverCents: 100_000, maxCheckCents: null })[0].summary).toMatch(/Maximum check amount removed/);
    expect(thresholdChanges({ secondSignatureOverCents: null, maxCheckCents: null }, prev)).toEqual([]);
  });

  it('holdFor: only the changer, only unconfirmed, only until hold_until', () => {
    const now = new Date('2026-10-20T12:00:00Z');
    const rows = [{ changed_by: 'a', confirmed_at: null, hold_until: '2026-10-21T10:00:00Z', summary: 'Signature 1 image uploaded or replaced' }];
    expect(holdFor(rows, 'a', now)?.reason).toMatch(/Another admin has to confirm/);
    expect(holdFor(rows, 'b', now)).toBeNull();
    expect(holdFor([{ ...rows[0], confirmed_at: '2026-10-20T11:00:00Z' }], 'a', now)).toBeNull();
    expect(holdFor(rows, 'a', new Date('2026-10-21T10:00:01Z'))).toBeNull();
  });

  it('confirmProblem: a different, admin user, once', () => {
    expect(confirmProblem({ changed_by: 'a', confirmed_at: null }, 'b', true)).toBeNull();
    expect(confirmProblem({ changed_by: 'a', confirmed_at: null }, 'a', true)).toMatch(/different admin/);
    expect(confirmProblem({ changed_by: 'a', confirmed_at: null }, 'b', false)).toMatch(/tenant admin/);
    expect(confirmProblem({ changed_by: 'a', confirmed_at: '2026-10-20T00:00:00Z' }, 'b', true)).toMatch(/already confirmed/);
  });
});
