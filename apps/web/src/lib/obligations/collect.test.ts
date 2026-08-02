import { describe, it, expect } from 'vitest';
import {
  daysBetween,
  daysUntilDue,
  severityForDays,
  horizonForDays,
  withinHorizon,
  makeObligation,
  filterToHorizon,
  rankObligations,
  bucketByHorizon,
  frequencyMonths,
  nextRecurrence,
  type RawObligation,
  type Obligation,
} from './collect';

const ASOF = '2026-08-02';

function raw(over: Partial<RawObligation> = {}): RawObligation {
  return {
    type: 'LEASE',
    category: 'MATURITY',
    title: 'Test',
    subtitle: null,
    dueDate: '2026-08-02',
    amountCents: null,
    entityId: 'e1',
    href: '/x',
    ...over,
  };
}

describe('date math', () => {
  it('daysBetween counts whole days', () => {
    expect(daysBetween('2026-08-02', '2026-08-09')).toBe(7);
    expect(daysBetween('2026-08-02', '2026-08-01')).toBe(-1);
    expect(daysBetween('2026-08-02', '2026-08-02')).toBe(0);
  });

  it('returns null on malformed dates', () => {
    expect(daysBetween('nope', '2026-08-02')).toBeNull();
    expect(daysUntilDue(ASOF, null)).toBeNull();
    expect(daysUntilDue(ASOF, undefined)).toBeNull();
  });

  it('daysUntilDue tolerates a full timestamp', () => {
    expect(daysUntilDue(ASOF, '2026-08-12T00:00:00Z')).toBe(10);
  });
});

describe('severity bucketing (overdue > urgent > soon > upcoming)', () => {
  it('classifies each band by days-until-due', () => {
    expect(severityForDays(-1)).toBe('OVERDUE');
    expect(severityForDays(-90)).toBe('OVERDUE');
    expect(severityForDays(0)).toBe('URGENT');
    expect(severityForDays(7)).toBe('URGENT');
    expect(severityForDays(8)).toBe('SOON');
    expect(severityForDays(30)).toBe('SOON');
    expect(severityForDays(31)).toBe('UPCOMING');
    expect(severityForDays(365)).toBe('UPCOMING');
  });
});

describe('horizon bucketing', () => {
  it('maps days into OVERDUE / D30 / D60 / D90', () => {
    expect(horizonForDays(-1)).toBe('OVERDUE');
    expect(horizonForDays(0)).toBe('D30');
    expect(horizonForDays(30)).toBe('D30');
    expect(horizonForDays(31)).toBe('D60');
    expect(horizonForDays(60)).toBe('D60');
    expect(horizonForDays(61)).toBe('D90');
    expect(horizonForDays(90)).toBe('D90');
  });

  it('withinHorizon always keeps overdue and cuts beyond the window', () => {
    expect(withinHorizon(-40, 90)).toBe(true);
    expect(withinHorizon(90, 90)).toBe(true);
    expect(withinHorizon(91, 90)).toBe(false);
  });
});

describe('makeObligation common-shape mapping', () => {
  it('derives daysUntil + severity from asOf', () => {
    const o = makeObligation(ASOF, raw({ dueDate: '2026-08-09' }));
    expect(o).not.toBeNull();
    expect(o?.daysUntil).toBe(7);
    expect(o?.severity).toBe('URGENT');
    // Passthrough fields are preserved.
    expect(o?.type).toBe('LEASE');
    expect(o?.href).toBe('/x');
  });

  it('flags an overdue item negative', () => {
    const o = makeObligation(ASOF, raw({ dueDate: '2026-07-02' }));
    expect(o?.daysUntil).toBe(-31);
    expect(o?.severity).toBe('OVERDUE');
  });

  it('returns null when the due date is unusable', () => {
    expect(makeObligation(ASOF, raw({ dueDate: '' }))).toBeNull();
    expect(makeObligation(ASOF, raw({ dueDate: 'garbage' }))).toBeNull();
  });
});

describe('filterToHorizon', () => {
  const items: Obligation[] = [
    makeObligation(ASOF, raw({ entityId: 'overdue', dueDate: '2026-06-01' }))!,
    makeObligation(ASOF, raw({ entityId: 'in30', dueDate: '2026-08-20' }))!,
    makeObligation(ASOF, raw({ entityId: 'in90', dueDate: '2026-10-25' }))!,
    makeObligation(ASOF, raw({ entityId: 'far', dueDate: '2027-01-01' }))!,
  ];

  it('keeps overdue + within-window, drops beyond horizon', () => {
    const kept = filterToHorizon(items, 90).map((o) => o.entityId);
    expect(kept).toContain('overdue');
    expect(kept).toContain('in30');
    expect(kept).toContain('in90');
    expect(kept).not.toContain('far');
  });
});

describe('rankObligations', () => {
  it('orders soonest/most-overdue first, then larger amount, then title', () => {
    const items: Obligation[] = [
      makeObligation(ASOF, raw({ entityId: 'a', title: 'A', dueDate: '2026-08-20', amountCents: 100 }))!,
      makeObligation(ASOF, raw({ entityId: 'b', title: 'B', dueDate: '2026-06-01' }))!,
      makeObligation(ASOF, raw({ entityId: 'c', title: 'C', dueDate: '2026-08-20', amountCents: 900 }))!,
    ];
    const order = rankObligations(items).map((o) => o.entityId);
    // b is overdue (first); then same-day c (bigger amount) before a.
    expect(order).toEqual(['b', 'c', 'a']);
  });

  it('is a pure copy — does not mutate input order', () => {
    const items: Obligation[] = [
      makeObligation(ASOF, raw({ entityId: 'later', dueDate: '2026-09-01' }))!,
      makeObligation(ASOF, raw({ entityId: 'sooner', dueDate: '2026-08-03' }))!,
    ];
    const before = items.map((o) => o.entityId);
    rankObligations(items);
    expect(items.map((o) => o.entityId)).toEqual(before);
  });
});

describe('bucketByHorizon', () => {
  it('groups ranked obligations into the four columns', () => {
    const items: Obligation[] = [
      makeObligation(ASOF, raw({ entityId: 'od', dueDate: '2026-07-01' }))!,
      makeObligation(ASOF, raw({ entityId: 'd30', dueDate: '2026-08-20' }))!,
      makeObligation(ASOF, raw({ entityId: 'd60', dueDate: '2026-09-20' }))!,
      makeObligation(ASOF, raw({ entityId: 'd90', dueDate: '2026-10-25' }))!,
    ];
    const b = bucketByHorizon(items);
    expect(b.OVERDUE.map((o) => o.entityId)).toEqual(['od']);
    expect(b.D30.map((o) => o.entityId)).toEqual(['d30']);
    expect(b.D60.map((o) => o.entityId)).toEqual(['d60']);
    expect(b.D90.map((o) => o.entityId)).toEqual(['d90']);
  });
});

describe('recurrence (covenant test dates derived from frequency)', () => {
  it('maps frequency to months', () => {
    expect(frequencyMonths('MONTHLY')).toBe(1);
    expect(frequencyMonths('QUARTERLY')).toBe(3);
    expect(frequencyMonths('SEMIANNUAL')).toBe(6);
    expect(frequencyMonths('ANNUAL')).toBe(12);
    expect(frequencyMonths('WEEKLY')).toBeNull();
    expect(frequencyMonths(null)).toBeNull();
  });

  it('finds the next quarterly test on/after asOf', () => {
    // Anchored 2026-01-15, quarterly → Jan, Apr, Jul, Oct; next on/after Aug 2 = Oct 15.
    expect(nextRecurrence('2026-01-15', 3, ASOF)).toBe('2026-10-15');
  });

  it('returns the anchor itself when it already lands on/after asOf', () => {
    expect(nextRecurrence('2026-08-02', 3, ASOF)).toBe('2026-08-02');
    expect(nextRecurrence('2026-12-01', 12, ASOF)).toBe('2026-12-01');
  });

  it('degrades to null on bad inputs', () => {
    expect(nextRecurrence(null, 3, ASOF)).toBeNull();
    expect(nextRecurrence('2026-01-15', null, ASOF)).toBeNull();
    expect(nextRecurrence('2026-01-15', 0, ASOF)).toBeNull();
  });
});
