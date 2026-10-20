import { describe, expect, it } from 'vitest';
import { centsToCell, normKey, parseBoolCell, parseDateCell, parseHoursCell, parseIntCell, parseMoneyCell, parsePctCell } from './values';

const v = <T>(p: { ok: boolean; value?: T | null }) => (p.ok ? p.value : 'ERR');

describe('parseMoneyCell', () => {
  it('parses formatted dollars to integer cents', () => {
    expect(v(parseMoneyCell('$1,234.56'))).toBe(123456);
    expect(v(parseMoneyCell('1234.5'))).toBe(123450);
    expect(v(parseMoneyCell('1234'))).toBe(123400);
    expect(v(parseMoneyCell('  $0.07 '))).toBe(7);
  });
  it('reads Excel float noise from the string, not via float math', () => {
    expect(v(parseMoneyCell('12345.670000000002'))).toBe(1234567);
    expect(v(parseMoneyCell('0.1'))).toBe(10);
  });
  it('blank / n/a is unknown (null), never zero', () => {
    expect(v(parseMoneyCell(''))).toBeNull();
    expect(v(parseMoneyCell('  '))).toBeNull();
    expect(v(parseMoneyCell('N/A'))).toBeNull();
    expect(v(parseMoneyCell(undefined))).toBeNull();
  });
  it('negatives only where allowed', () => {
    expect(parseMoneyCell('(1,234.56)').ok).toBe(false);
    expect(v(parseMoneyCell('(1,234.56)', { allowNegative: true }))).toBe(-123456);
    expect(v(parseMoneyCell('-12.30', { allowNegative: true }))).toBe(-1230);
    expect(v(parseMoneyCell('45.00 CR', { allowNegative: true }))).toBe(-4500);
  });
  it('rejects non-money', () => {
    expect(parseMoneyCell('abc').ok).toBe(false);
    expect(parseMoneyCell('12.3.4').ok).toBe(false);
  });
});

describe('parseDateCell', () => {
  it('accepts the explicit formats', () => {
    expect(v(parseDateCell('2026-01-05'))).toBe('2026-01-05');
    expect(v(parseDateCell('2026-01-05T00:00:00Z'))).toBe('2026-01-05');
    expect(v(parseDateCell('1/5/2026'))).toBe('2026-01-05');
    expect(v(parseDateCell('01/05/26'))).toBe('2026-01-05');
    expect(v(parseDateCell('12/31/99'))).toBe('1999-12-31');
    expect(v(parseDateCell('1-5-2026'))).toBe('2026-01-05');
    expect(v(parseDateCell('Jan 5, 2026'))).toBe('2026-01-05');
    expect(v(parseDateCell('5-Jan-2026'))).toBe('2026-01-05');
    expect(v(parseDateCell('05-JAN-26'))).toBe('2026-01-05');
    expect(v(parseDateCell('Sept 30, 2026'))).toBe('2026-09-30');
  });
  it('reads Excel serial day numbers', () => {
    expect(v(parseDateCell('46027'))).toBe('2026-01-05');
  });
  it('rejects impossible dates and ambiguity it cannot read', () => {
    expect(parseDateCell('2026-02-30').ok).toBe(false);
    expect(parseDateCell('13/01/2026').ok).toBe(false);
    expect(parseDateCell('next tuesday').ok).toBe(false);
    expect(parseDateCell('123').ok).toBe(false);
  });
  it('blank is null', () => {
    expect(v(parseDateCell(''))).toBeNull();
  });
});

describe('other cells', () => {
  it('ints', () => {
    expect(v(parseIntCell('1,200'))).toBe(1200);
    expect(v(parseIntCell('12.0'))).toBe(12);
    expect(parseIntCell('12.5').ok).toBe(false);
    expect(parseIntCell('1899', { min: 1900 }).ok).toBe(false);
  });
  it('hours to hundredths as a string', () => {
    expect(v(parseHoursCell('1.5'))).toBe('1.50');
    expect(v(parseHoursCell('2'))).toBe('2.00');
    expect(v(parseHoursCell('1.755'))).toBe('1.76');
    expect(v(parseHoursCell('3 hrs'))).toBe('3.00');
    expect(parseHoursCell('-1').ok).toBe(false);
  });
  it('percent to bps', () => {
    expect(v(parsePctCell('25%'))).toBe(2500);
    expect(v(parsePctCell('25'))).toBe(2500);
    expect(v(parsePctCell('2.5'))).toBe(250);
    expect(v(parsePctCell('0.25'))).toBe(25);
    expect(parsePctCell('abc').ok).toBe(false);
  });
  it('bools', () => {
    expect(v(parseBoolCell('Yes'))).toBe(true);
    expect(v(parseBoolCell('n'))).toBe(false);
    expect(parseBoolCell('maybe').ok).toBe(false);
  });
  it('cents to cell text and keys', () => {
    expect(centsToCell(123456)).toBe('1234.56');
    expect(centsToCell(-5)).toBe('-0.05');
    expect(centsToCell(null)).toBe('');
    expect(normKey(' ab-12 34 ')).toBe('AB1234');
  });
});
