import { describe, it, expect } from 'vitest';
import {
  maskLast4,
  normalizeMethod,
  normalizeAccountType,
  hasBankDetails,
} from './vendor-payment-details';

describe('maskLast4', () => {
  it('keeps only the last 4 digits behind a fixed mask', () => {
    expect(maskLast4('123456789')).toBe('****6789');
    expect(maskLast4('4321')).toBe('****4321');
  });

  it('strips non-digits before masking (spaces, dashes)', () => {
    expect(maskLast4('1234-5678')).toBe('****5678');
    expect(maskLast4(' 12 34 56 ')).toBe('****3456');
  });

  it('never returns anything but the last 4 — the full number cannot survive', () => {
    const masked = maskLast4('987654321012');
    expect(masked).toBe('****1012');
    expect(masked).not.toContain('9876');
  });

  it('is idempotent on an already-masked value', () => {
    expect(maskLast4('****1234')).toBe('****1234');
    expect(maskLast4(maskLast4('55551234')!)).toBe('****1234');
  });

  it('returns null for missing or too-short input', () => {
    expect(maskLast4(null)).toBeNull();
    expect(maskLast4(undefined)).toBeNull();
    expect(maskLast4('12')).toBeNull();
    expect(maskLast4('')).toBeNull();
  });
});

describe('normalizeMethod', () => {
  it('defaults to ACH and recognizes CHECK case-insensitively', () => {
    expect(normalizeMethod('check')).toBe('CHECK');
    expect(normalizeMethod('CHECK')).toBe('CHECK');
    expect(normalizeMethod('ach')).toBe('ACH');
    expect(normalizeMethod(null)).toBe('ACH');
    expect(normalizeMethod('anything')).toBe('ACH');
  });
});

describe('normalizeAccountType', () => {
  it('accepts checking/savings and rejects the rest', () => {
    expect(normalizeAccountType('checking')).toBe('checking');
    expect(normalizeAccountType('SAVINGS')).toBe('savings');
    expect(normalizeAccountType('other')).toBeNull();
    expect(normalizeAccountType(null)).toBeNull();
  });
});

describe('hasBankDetails', () => {
  it('CHECK always remit-ready (pays to the mailing address)', () => {
    expect(hasBankDetails({ paymentMethod: 'CHECK', accountMask: null, routingMask: null })).toBe(true);
  });

  it('ACH needs a masked account on file', () => {
    expect(hasBankDetails({ paymentMethod: 'ACH', accountMask: null, routingMask: '****1111' })).toBe(false);
    expect(hasBankDetails({ paymentMethod: 'ACH', accountMask: '****1234', routingMask: '****1111' })).toBe(true);
  });
});
