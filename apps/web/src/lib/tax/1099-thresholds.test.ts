import { describe, it, expect } from 'vitest';
import {
  get1099Thresholds,
  necThresholdCents,
  miscBoxThresholdCents,
  meetsNecThreshold,
  meets1099KThreshold,
  formatThresholdUsd,
  IRS_INDEXED_GENERAL_THRESHOLD_CENTS,
} from './1099-thresholds';
import { isTen99Candidate } from '@/app/api/compliance/1099/readiness';

describe('1099 thresholds — pre-OBBBA years (≤ 2025): $600', () => {
  it.each([2020, 2023, 2024, 2025])('%i uses $600 NEC / MISC general', (y) => {
    const t = get1099Thresholds(y);
    expect(t.regime).toBe('PRE_OBBBA');
    expect(t.necCents).toBe(60_000);
    expect(t.miscBoxCents.MISC_1).toBe(60_000);
    expect(t.miscBoxCents.MISC_3).toBe(60_000);
    expect(t.miscBoxCents.MISC_6).toBe(60_000);
    expect(t.backupWithholdingCents).toBe(60_000);
    expect(t.provisional).toBe(false);
    expect(t.notice).toBeNull();
  });

  it('$600 is "at least", not "over"', () => {
    expect(meetsNecThreshold(2025, 60_000)).toBe(true);
    expect(meetsNecThreshold(2025, 59_999)).toBe(false);
  });
});

describe('1099 thresholds — 2026 (OBBBA): $2,000', () => {
  const t = get1099Thresholds(2026);

  it('raises NEC + general MISC boxes + backup withholding to $2,000', () => {
    expect(t.regime).toBe('OBBBA');
    expect(t.necCents).toBe(200_000);
    expect(t.generalCents).toBe(200_000);
    expect(t.miscBoxCents.MISC_1).toBe(200_000); // rents
    expect(t.miscBoxCents.MISC_3).toBe(200_000); // other income
    expect(t.miscBoxCents.MISC_6).toBe(200_000); // medical
    expect(t.miscBoxCents.MISC_9).toBe(200_000); // crop insurance
    expect(t.backupWithholdingCents).toBe(200_000);
    expect(t.provisional).toBe(false);
  });

  it('never silently falls back to $600 for the general floor', () => {
    expect(necThresholdCents(2026)).not.toBe(60_000);
    expect(meetsNecThreshold(2026, 60_000)).toBe(false);
    expect(meetsNecThreshold(2026, 199_999)).toBe(false);
    expect(meetsNecThreshold(2026, 200_000)).toBe(true);
  });

  it('keeps the sections OBBBA did not touch: royalties $10, substitute $10, attorney proceeds $600, direct sales $5,000', () => {
    expect(miscBoxThresholdCents(2026, 'MISC_2')).toBe(1_000);
    expect(miscBoxThresholdCents(2026, 'MISC_8')).toBe(1_000);
    expect(miscBoxThresholdCents(2026, 'MISC_10')).toBe(60_000);
    expect(t.directSalesCents).toBe(500_000);
  });
});

describe('1099 thresholds — 2027+ (inflation-indexed)', () => {
  it('2027 with no IRS-published amount is provisional at the $2,000 base (never $600)', () => {
    expect(IRS_INDEXED_GENERAL_THRESHOLD_CENTS[2027]).toBeUndefined();
    const t = get1099Thresholds(2027);
    expect(t.regime).toBe('OBBBA_INDEXED');
    expect(t.necCents).toBe(200_000);
    expect(t.provisional).toBe(true);
    expect(t.notice).toMatch(/2027/);
    expect(t.notice).toMatch(/\$2,000/);
  });

  it('later years stay provisional and conservative until published', () => {
    const t = get1099Thresholds(2030);
    expect(t.provisional).toBe(true);
    expect(t.necCents).toBeGreaterThanOrEqual(200_000);
    // Royalties / attorney proceeds are not indexed.
    expect(t.miscBoxCents.MISC_2).toBe(1_000);
    expect(t.miscBoxCents.MISC_10).toBe(60_000);
  });
});

describe('1099-K — $20,000 AND 200 transactions (strictly exceeds)', () => {
  it.each([2024, 2025, 2026, 2027])('%i', (y) => {
    expect(meets1099KThreshold(y, 2_000_001, 201)).toBe(true);
    expect(meets1099KThreshold(y, 2_000_000, 500)).toBe(false); // exactly $20,000 does not exceed
    expect(meets1099KThreshold(y, 5_000_000, 200)).toBe(false); // exactly 200 does not exceed
    expect(meets1099KThreshold(y, 1_000_000, 1_000)).toBe(false);
  });
});

describe('input guards + formatting', () => {
  it('rejects non-integer / out-of-range tax years', () => {
    expect(() => get1099Thresholds(2026.5)).toThrow(RangeError);
    expect(() => get1099Thresholds(0)).toThrow(RangeError);
    expect(() => get1099Thresholds(20_260)).toThrow(RangeError);
  });

  it('formats cents as whole-dollar copy without float math', () => {
    expect(formatThresholdUsd(200_000)).toBe('$2,000');
    expect(formatThresholdUsd(60_000)).toBe('$600');
    expect(formatThresholdUsd(1_000)).toBe('$10');
    expect(formatThresholdUsd(2_000_000)).toBe('$20,000');
    expect(formatThresholdUsd(60_050)).toBe('$600.50');
  });
});

describe('readiness candidacy uses the tax-year floor (+ box-specific floors)', () => {
  it('a $900 services vendor is a 2025 candidate but not a 2026 one', () => {
    expect(isTen99Candidate(90_000, { NEC_1: 90_000 }, 2025)).toBe(true);
    expect(isTen99Candidate(90_000, { NEC_1: 90_000 }, 2026)).toBe(false);
  });

  it('a $700 attorney settlement or a $15 royalty is still a 2026 candidate', () => {
    expect(isTen99Candidate(70_000, { MISC_10: 70_000 }, 2026)).toBe(true);
    expect(isTen99Candidate(1_500, { MISC_2: 1_500 }, 2026)).toBe(true);
  });

  it('a $1,500 rent is not a 2026 candidate', () => {
    expect(isTen99Candidate(150_000, { MISC_1: 150_000 }, 2026)).toBe(false);
  });
});
