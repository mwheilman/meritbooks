import { describe, it, expect } from 'vitest';
import {
  cadenceForInterval,
  detectCadence,
  detectPriceIncrease,
  nextRenewalDate,
  annualizedCents,
  detectSubscriptions,
  applyDuplicateCategory,
  summarizeCreep,
  subscriptionDedupKey,
  addDaysIso,
  type ChargeInput,
  type DetectedSubscription,
} from './detect';

// Helper: build a run of monthly charges starting at `start`, `n` of them, `amount` cents.
function monthly(vendor: string, start: string, n: number, amount: number, opts?: { category?: string }): ChargeInput[] {
  const out: ChargeInput[] = [];
  let d = start;
  for (let i = 0; i < n; i++) {
    out.push({ id: `${vendor}-${i}`, vendorRaw: vendor, amountCents: amount, date: d, category: opts?.category ?? null });
    d = addDaysIso(d, 30)!;
  }
  return out;
}

describe('cadenceForInterval', () => {
  it('maps interval bands to named cadences', () => {
    expect(cadenceForInterval(30)).toBe('MONTHLY');
    expect(cadenceForInterval(31)).toBe('MONTHLY');
    expect(cadenceForInterval(91)).toBe('QUARTERLY');
    expect(cadenceForInterval(365)).toBe('ANNUAL');
    expect(cadenceForInterval(7)).toBe('OTHER');
    expect(cadenceForInterval(200)).toBe('OTHER');
  });
});

describe('detectCadence', () => {
  it('infers monthly cadence with high regularity', () => {
    const c = detectCadence(['2026-01-01', '2026-01-31', '2026-03-02', '2026-04-01']);
    expect(c).not.toBeNull();
    expect(c!.cadence).toBe('MONTHLY');
    expect(c!.regularity).toBeGreaterThanOrEqual(0.9);
  });

  it('infers annual cadence', () => {
    const c = detectCadence(['2024-06-01', '2025-06-01', '2026-06-01']);
    expect(c!.cadence).toBe('ANNUAL');
  });

  it('returns null for a single charge', () => {
    expect(detectCadence(['2026-01-01'])).toBeNull();
  });

  it('lowers regularity for irregular gaps', () => {
    const c = detectCadence(['2026-01-01', '2026-01-31', '2026-02-05', '2026-08-01']);
    expect(c!.regularity).toBeLessThan(1);
  });
});

describe('nextRenewalDate', () => {
  it('adds one cadence interval to the last charge', () => {
    expect(nextRenewalDate('2026-06-01', 'MONTHLY', 30)).toBe('2026-07-01');
    expect(nextRenewalDate('2026-06-01', 'ANNUAL', 365)).toBe('2027-06-01');
  });
  it('uses the observed interval for OTHER cadence', () => {
    expect(nextRenewalDate('2026-06-01', 'OTHER', 14)).toBe('2026-06-15');
  });
});

describe('annualizedCents', () => {
  it('annualizes by cadence', () => {
    expect(annualizedCents(1000, 'MONTHLY', 30)).toBe(12167); // 1000*365/30
    expect(annualizedCents(1000, 'QUARTERLY', 91)).toBe(4011);
    expect(annualizedCents(12000, 'ANNUAL', 365)).toBe(12000);
  });
});

describe('detectPriceIncrease', () => {
  it('flags a material increase in the latest charge', () => {
    const p = detectPriceIncrease([1000, 1000, 1000, 1200]);
    expect(p.increased).toBe(true);
    expect(p.priorCents).toBe(1000);
    expect(p.currentCents).toBe(1200);
    expect(p.pctIncrease).toBeCloseTo(0.2, 5);
  });
  it('does not flag a trivial change', () => {
    expect(detectPriceIncrease([1000, 1000, 1010]).increased).toBe(false);
  });
  it('handles a single charge', () => {
    expect(detectPriceIncrease([1000]).increased).toBe(false);
  });
});

describe('detectSubscriptions', () => {
  const asOf = '2026-09-01';

  it('detects a steady monthly subscription with cadence, amount, and next renewal', () => {
    const subs = detectSubscriptions(monthly('NETFLIX', '2026-01-05', 6, 1599), { asOf });
    expect(subs).toHaveLength(1);
    const s = subs[0];
    expect(s.billingCadence).toBe('MONTHLY');
    expect(s.amountCents).toBe(1599);
    expect(s.chargeCount).toBe(6);
    expect(s.firstSeenDate).toBe('2026-01-05');
    expect(s.nextRenewalDate).toBe(addDaysIso(s.lastChargedDate, 30));
    expect(s.dedupKey).toBe(subscriptionDedupKey('NETFLIX', 'MONTHLY'));
  });

  it('flags PRICE_INCREASE and records the prior amount', () => {
    const charges = [
      ...monthly('SLACK', '2026-01-01', 3, 800),
      { id: 'SLACK-hike', vendorRaw: 'SLACK', amountCents: 1000, date: '2026-04-01', category: null },
    ];
    const s = detectSubscriptions(charges, { asOf }).find((x) => x.vendorName === 'SLACK')!;
    expect(s.creepFlags).toContain('PRICE_INCREASE');
    expect(s.priorAmountCents).toBe(800);
  });

  it('flags NEW when first seen inside the window', () => {
    const subs = detectSubscriptions(monthly('NEWTOOL', '2026-07-10', 2, 500), { asOf });
    expect(subs[0].creepFlags).toContain('NEW');
  });

  it('flags STALE when no charge for longer than the expected interval', () => {
    // last charge months before asOf → stale
    const subs = detectSubscriptions(monthly('ZOMBIE', '2026-01-01', 3, 500), { asOf: '2026-09-01' });
    expect(subs[0].creepFlags).toContain('STALE');
  });

  it('ignores one-off charges and non-recurring vendors', () => {
    const charges: ChargeInput[] = [
      { id: 'a', vendorRaw: 'ONE OFF STORE', amountCents: 5000, date: '2026-01-01', category: null },
      ...monthly('REAL SUB', '2026-06-01', 3, 999),
    ];
    const subs = detectSubscriptions(charges, { asOf });
    expect(subs.map((s) => s.vendorName)).toEqual(['REAL SUB']);
  });

  it('groups by normalized vendor across noisy descriptions', () => {
    const charges: ChargeInput[] = [
      { id: '1', vendorRaw: 'ADOBE  *SUBSCRIPTION', amountCents: 5299, date: '2026-05-01', category: null },
      { id: '2', vendorRaw: 'adobe subscription', amountCents: 5299, date: '2026-05-31', category: null },
      { id: '3', vendorRaw: 'Adobe Subscription', amountCents: 5299, date: '2026-06-30', category: null },
    ];
    const subs = detectSubscriptions(charges, { asOf });
    expect(subs).toHaveLength(1);
    expect(subs[0].chargeCount).toBe(3);
  });
});

describe('applyDuplicateCategory', () => {
  it('flags subscriptions sharing a category', () => {
    const base: DetectedSubscription = {
      dedupKey: 'x', vendorName: 'A', vendorId: null, category: 'CRM', amountCents: 1000,
      priorAmountCents: null, billingCadence: 'MONTHLY', intervalDays: 30, regularity: 1,
      firstSeenDate: '2026-01-01', lastChargedDate: '2026-03-01', nextRenewalDate: '2026-04-01',
      chargeCount: 3, chargeTxnIds: [], annualizedCents: 12000, creepFlags: [], confidence: 0.8,
    };
    const out = applyDuplicateCategory([
      { ...base, dedupKey: 'a', vendorName: 'Salesforce', category: 'CRM' },
      { ...base, dedupKey: 'b', vendorName: 'HubSpot', category: 'CRM' },
      { ...base, dedupKey: 'c', vendorName: 'AWS', category: 'Hosting' },
    ]);
    expect(out[0].creepFlags).toContain('DUPLICATE_CATEGORY');
    expect(out[1].creepFlags).toContain('DUPLICATE_CATEGORY');
    expect(out[2].creepFlags).not.toContain('DUPLICATE_CATEGORY');
  });
});

describe('summarizeCreep', () => {
  it('totals live subscription spend and creep counts, excluding CANCELLED', () => {
    const s = summarizeCreep([
      { billingCadence: 'MONTHLY', amountCents: 1000, annualizedCents: 12000, creepFlags: ['NEW'], status: 'DETECTED' },
      { billingCadence: 'ANNUAL', amountCents: 120000, annualizedCents: 120000, creepFlags: ['PRICE_INCREASE'], status: 'ACTIVE' },
      { billingCadence: 'MONTHLY', amountCents: 9999, annualizedCents: 119988, creepFlags: [], status: 'CANCELLED' },
    ]);
    expect(s.count).toBe(2);
    expect(s.totalAnnualCents).toBe(132000);
    expect(s.totalMonthlyCents).toBe(11000);
    expect(s.newCount).toBe(1);
    expect(s.priceIncreaseCount).toBe(1);
  });
});
