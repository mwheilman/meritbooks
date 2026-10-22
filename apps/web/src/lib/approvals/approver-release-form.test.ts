import { describe, it, expect } from 'vitest';
import {
  APPROVER_RELEASE_OPTIONS,
  approverReleaseConfirmation,
  centsToInput,
  parseDollarsToCents,
  samePolicy,
  validateApproverReleaseForm,
} from './approver-release-form';

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

describe('approver-release form (mig 174 setting)', () => {
  it('offers exactly the three owner choices, in order, in plain English', () => {
    expect(APPROVER_RELEASE_OPTIONS.map((o) => o.value)).toEqual(['off', 'any', 'up_to']);
    for (const o of APPROVER_RELEASE_OPTIONS) expect(o.help).not.toMatch(/\b(H6|SoD|sole_approver)\b/);
  });

  it('parses dollar text to integer cents without floating point', () => {
    expect(parseDollarsToCents('5000')).toBe(500_000);
    expect(parseDollarsToCents('5,000')).toBe(500_000);
    expect(parseDollarsToCents('$ 5,000.5')).toBe(500_050);
    expect(parseDollarsToCents('0.29')).toBe(29);
    expect(parseDollarsToCents('1,234,567.89')).toBe(123_456_789);
    for (const bad of ['', 'abc', '-5', '5.001', '5,00', '1e3', '5.']) expect(parseDollarsToCents(bad)).toBeNull();
  });

  it('round-trips cents through the input box', () => {
    expect(centsToInput(null)).toBe('');
    expect(centsToInput(500_000)).toBe('5000');
    expect(centsToInput(500_050)).toBe('5000.50');
    expect(parseDollarsToCents(centsToInput(123_456_789))).toBe(123_456_789);
  });

  it('validates: off / any need no amount; up to needs a positive amount within $1B', () => {
    expect(validateApproverReleaseForm('off', 'junk')).toEqual({ ok: true, policy: { choice: 'off', maxCents: null } });
    expect(validateApproverReleaseForm('any', '')).toEqual({ ok: true, policy: { choice: 'any', maxCents: null } });
    expect(validateApproverReleaseForm('up_to', '2,500')).toEqual({ ok: true, policy: { choice: 'up_to', maxCents: 250_000 } });
    expect(validateApproverReleaseForm('up_to', '')).toMatchObject({ ok: false, error: expect.stringMatching(/most an approver/) });
    expect(validateApproverReleaseForm('up_to', '0')).toMatchObject({ ok: false, error: expect.stringMatching(/greater than \$0/) });
    expect(validateApproverReleaseForm('up_to', 'five')).toMatchObject({ ok: false, error: expect.stringMatching(/dollar amount/) });
    expect(validateApproverReleaseForm('up_to', '1000000001')).toMatchObject({ ok: false, error: expect.stringMatching(/or less/) });
  });

  it('compares policies (the amount only matters for up to)', () => {
    expect(samePolicy({ choice: 'any', maxCents: null }, { choice: 'any', maxCents: null })).toBe(true);
    expect(samePolicy({ choice: 'up_to', maxCents: 1 }, { choice: 'up_to', maxCents: 2 })).toBe(false);
    expect(samePolicy({ choice: 'off', maxCents: null }, { choice: 'any', maxCents: null })).toBe(false);
  });

  it('confirmation copy names the limit and always says payroll needs a second person', () => {
    const up = approverReleaseConfirmation({ choice: 'up_to', maxCents: 500_000 }, money);
    expect(up.title).toContain('$5000.00');
    expect(up.body).toMatch(/over \$5000\.00 needs a second person/);
    for (const c of ['off', 'any', 'up_to'] as const) {
      expect(approverReleaseConfirmation({ choice: c, maxCents: c === 'up_to' ? 100 : null }, money).body).toMatch(/Payroll always needs a second person/);
    }
  });
});
