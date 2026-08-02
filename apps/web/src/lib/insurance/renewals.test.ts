import { describe, it, expect } from 'vitest';
import { dueRenewals, daysBetween, type RenewablePolicy } from './renewals';

function policy(over: Partial<RenewablePolicy> & { id: string }): RenewablePolicy {
  return {
    carrier: 'Acme',
    policy_number: null,
    coverage_type: 'GL',
    premium_cents: 100_000,
    premium_frequency: 'ANNUAL',
    expiration_date: '2026-12-31',
    status: 'ACTIVE',
    ...over,
  };
}

describe('daysBetween', () => {
  it('counts whole days and returns null for malformed input', () => {
    expect(daysBetween('2026-08-02', '2026-08-12')).toBe(10);
    expect(daysBetween('2026-08-02', '2026-08-01')).toBe(-1);
    expect(daysBetween('nope', '2026-08-01')).toBeNull();
  });
});

describe('dueRenewals', () => {
  const asOf = '2026-08-02';

  it('includes only policies expiring within the window, sorted soonest-first', () => {
    const out = dueRenewals(
      [
        policy({ id: 'far', expiration_date: '2027-01-01' }), // outside 60-day window
        policy({ id: 'soon', expiration_date: '2026-08-20' }), // 18 days
        policy({ id: 'sooner', expiration_date: '2026-08-10' }), // 8 days
      ],
      asOf,
      60,
    );
    expect(out.map((r) => r.policy.id)).toEqual(['sooner', 'soon']);
    expect(out[0].daysUntil).toBe(8);
    expect(out[1].daysUntil).toBe(18);
  });

  it('flags already-lapsed active policies as overdue and puts them first', () => {
    const out = dueRenewals(
      [
        policy({ id: 'lapsed', expiration_date: '2026-07-25' }), // -8 days
        policy({ id: 'upcoming', expiration_date: '2026-08-15' }), // 13 days
      ],
      asOf,
      60,
    );
    expect(out.map((r) => r.policy.id)).toEqual(['lapsed', 'upcoming']);
    expect(out[0].overdue).toBe(true);
    expect(out[0].daysUntil).toBe(-8);
    expect(out[1].overdue).toBe(false);
  });

  it('excludes cancelled / expired policies and those with no expiration date', () => {
    const out = dueRenewals(
      [
        policy({ id: 'cancelled', status: 'CANCELLED', expiration_date: '2026-08-05' }),
        policy({ id: 'expired', status: 'EXPIRED', expiration_date: '2026-08-05' }),
        policy({ id: 'no-date', expiration_date: null }),
        policy({ id: 'pending', status: 'PENDING', expiration_date: '2026-08-05' }),
      ],
      asOf,
      60,
    );
    expect(out.map((r) => r.policy.id)).toEqual(['pending']);
  });

  it('never throws on malformed input', () => {
    // @ts-expect-error — exercising the runtime guard
    expect(() => dueRenewals(null, asOf, 30)).not.toThrow();
    // @ts-expect-error — exercising the runtime guard
    expect(dueRenewals(null, asOf, 30)).toEqual([]);
  });
});
