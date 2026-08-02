import { describe, it, expect } from 'vitest';
import { dueRenewals, type RenewableSubscription } from './renewals';

function sub(over: Partial<RenewableSubscription> & { id: string }): RenewableSubscription {
  return {
    vendor_name: 'Acme',
    product: null,
    amount_cents: 1000,
    billing_cadence: 'MONTHLY',
    next_renewal_date: '2026-09-01',
    notice_period_days: null,
    status: 'ACTIVE',
    ...over,
  };
}

describe('dueRenewals', () => {
  const asOf = '2026-08-02';

  it('includes renewals whose notice deadline falls within the window, soonest-first', () => {
    const out = dueRenewals(
      [
        sub({ id: 'far', next_renewal_date: '2026-12-01' }),
        sub({ id: 'soon', next_renewal_date: '2026-08-20' }),
      ],
      asOf,
      30,
    );
    expect(out.map((r) => r.subscription.id)).toEqual(['soon']);
  });

  it('is notice-period-aware: a 30-day notice pulls a later renewal into the window', () => {
    // renews in 40 days, but requires 30 days notice → deadline in 10 days.
    const out = dueRenewals([sub({ id: 'notice', next_renewal_date: '2026-09-11', notice_period_days: 30 })], asOf, 14);
    expect(out).toHaveLength(1);
    expect(out[0].daysUntilNoticeDeadline).toBe(10);
    expect(out[0].noticeWindowPassed).toBe(false);
  });

  it('flags noticeWindowPassed when the deadline has already lapsed', () => {
    const out = dueRenewals([sub({ id: 'late', next_renewal_date: '2026-08-10', notice_period_days: 30 })], asOf, 30);
    expect(out[0].noticeWindowPassed).toBe(true);
    expect(out[0].daysUntilNoticeDeadline).toBeLessThan(0);
  });

  it('excludes CANCELLED and KEPT subscriptions', () => {
    const out = dueRenewals(
      [
        sub({ id: 'cancelled', status: 'CANCELLED', next_renewal_date: '2026-08-05' }),
        sub({ id: 'kept', status: 'KEPT', next_renewal_date: '2026-08-05' }),
      ],
      asOf,
      30,
    );
    expect(out).toHaveLength(0);
  });

  it('skips undated subscriptions and never throws', () => {
    expect(dueRenewals([sub({ id: 'nodate', next_renewal_date: null })], asOf, 30)).toHaveLength(0);
  });
});
