import { describe, it, expect } from 'vitest';
import {
  classify1099Box,
  apportionCents,
  mergeBoxCents,
  BOX_META,
  type BoxCents,
} from './box-classify';

describe('classify1099Box — GL account → 1099 box', () => {
  it('routes services / subcontractors to NEC Box 1 (the default)', () => {
    expect(classify1099Box('6100', 'Subcontractor Labor')).toBe('NEC_1');
    expect(classify1099Box('6200', 'Professional Fees')).toBe('NEC_1');
    expect(classify1099Box('6300', 'Contract Services')).toBe('NEC_1');
    expect(classify1099Box(null, null)).toBe('NEC_1');
  });

  it('routes rent / lease accounts to MISC Box 1 (Rents)', () => {
    expect(classify1099Box('6400', 'Office Rent')).toBe('MISC_1');
    expect(classify1099Box('6410', 'Equipment Rental')).toBe('MISC_1');
    expect(classify1099Box('6420', 'Equipment Lease')).toBe('MISC_1');
  });

  it('does NOT treat "release" or "leasehold improvements" as rent', () => {
    expect(classify1099Box('6500', 'Lien Release Fees')).toBe('NEC_1');
    expect(classify1099Box('1500', 'Leasehold Improvements')).toBe('NEC_1');
  });

  it('routes royalties to MISC Box 2', () => {
    expect(classify1099Box('6600', 'Royalty Expense')).toBe('MISC_2');
    expect(classify1099Box('6610', 'Franchise Royalties')).toBe('MISC_2');
  });

  it('routes medical / health care to MISC Box 6', () => {
    expect(classify1099Box('6700', 'Medical Services')).toBe('MISC_6');
    expect(classify1099Box('6710', 'Health Care Payments')).toBe('MISC_6');
    expect(classify1099Box('6720', 'Healthcare Reimbursement')).toBe('MISC_6');
  });

  it('routes attorney gross proceeds / settlements to MISC Box 10, but ordinary legal fees to NEC', () => {
    expect(classify1099Box('6800', 'Legal Settlement Payments')).toBe('MISC_10');
    expect(classify1099Box('6810', 'Gross Proceeds to Attorney')).toBe('MISC_10');
    // Ordinary attorney service fees are NEC Box 1, not MISC 10.
    expect(classify1099Box('6820', 'Legal Fees')).toBe('NEC_1');
    expect(classify1099Box('6830', 'Attorney Fees')).toBe('NEC_1');
  });

  it('routes prizes / awards / other income to MISC Box 3', () => {
    expect(classify1099Box('6900', 'Prize Payments')).toBe('MISC_3');
    expect(classify1099Box('6910', 'Contest Awards')).toBe('MISC_3');
  });

  it('every classified code has consistent form metadata', () => {
    for (const meta of Object.values(BOX_META)) {
      expect(meta.form).toBe(meta.code.startsWith('NEC') ? 'NEC' : 'MISC');
    }
  });
});

describe('apportionCents — integer-exact split across boxes', () => {
  it('sends the full amount to NEC when there are no weights', () => {
    expect(apportionCents(100_000, {})).toEqual({ NEC_1: 100_000 });
  });

  it('splits proportionally and preserves the exact total (largest-remainder)', () => {
    // $1000 across a 2:1 NEC:rent mix.
    const out = apportionCents(100_000, { NEC_1: 2000, MISC_1: 1000 });
    const total = Object.values(out).reduce((s, c) => s + (c ?? 0), 0);
    expect(total).toBe(100_000);
    expect(out.NEC_1).toBe(66_667);
    expect(out.MISC_1).toBe(33_333);
  });

  it('never loses a cent on an indivisible split', () => {
    const out = apportionCents(101, { NEC_1: 1, MISC_1: 1, MISC_6: 1 });
    const total = Object.values(out).reduce((s, c) => s + (c ?? 0), 0);
    expect(total).toBe(101);
  });

  it('returns empty for zero cents', () => {
    expect(apportionCents(0, { NEC_1: 100 })).toEqual({});
  });
});

describe('mergeBoxCents', () => {
  it('accumulates box maps in place', () => {
    const acc: BoxCents = { NEC_1: 100 };
    mergeBoxCents(acc, { NEC_1: 50, MISC_1: 25 });
    expect(acc).toEqual({ NEC_1: 150, MISC_1: 25 });
  });
});
