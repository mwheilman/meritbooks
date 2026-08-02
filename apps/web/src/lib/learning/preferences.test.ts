import { describe, it, expect } from 'vitest';
import { emptyLedger, tallyObservation, resolveLedger } from './preferences';

/**
 * These cover the PURE learner math behind the generic preference store — the part
 * that turns a stream of observations into a confident "typical choice". The DB I/O
 * (degrade-safe reads/writes) is exercised via the API route + integration paths.
 */

const AT0 = '2026-01-01T00:00:00.000Z';
const AT1 = '2026-02-01T00:00:00.000Z';
const AT2 = '2026-03-01T00:00:00.000Z';

function fold<T>(samples: Array<[T, string]>) {
  return samples.reduce((led, [s, at]) => tallyObservation(led, s, at), emptyLedger<T>());
}

describe('tallyObservation / resolveLedger', () => {
  it('an empty ledger resolves to nothing', () => {
    const r = resolveLedger(emptyLedger<string>());
    expect(r.value).toBeNull();
    expect(r.observations).toBe(0);
    expect(r.confidence).toBe(0);
  });

  it('collapses equal samples and counts total', () => {
    const led = fold<string>([
      ['last_month', AT0],
      ['last_month', AT1],
      ['this_month', AT2],
    ]);
    expect(led.total).toBe(3);
    expect(led.tally).toHaveLength(2);
    const r = resolveLedger(led);
    expect(r.value).toBe('last_month');
    expect(r.share).toBeCloseTo(2 / 3, 5);
  });

  it('hashes objects independent of key order', () => {
    const led = tallyObservation(
      tallyObservation(emptyLedger<Record<string, string>>(), { a: '1', b: '2' }, AT0),
      { b: '2', a: '1' },
      AT1,
    );
    // same logical value → one distinct entry with count 2
    expect(led.tally).toHaveLength(1);
    expect(led.tally[0].count).toBe(2);
  });

  it('confidence grows with consistency AND sample size, capped < 1', () => {
    const thin = resolveLedger(fold<string>([['x', AT0]]));
    const thick = resolveLedger(
      fold<string>([
        ['x', AT0],
        ['x', AT1],
        ['x', AT2],
        ['x', AT2],
        ['x', AT2],
      ]),
    );
    expect(thin.confidence).toBeLessThan(thick.confidence);
    expect(thick.confidence).toBeLessThanOrEqual(0.97);
    expect(thick.confidence).toBeGreaterThan(0.9);
  });

  it('breaks a count tie by recency (a fresh choice wins)', () => {
    const led = fold<string>([
      ['old', AT0],
      ['old', AT0],
      ['new', AT1],
      ['new', AT2],
    ]);
    // both have count 2; 'new' is more recent → it wins
    expect(resolveLedger(led).value).toBe('new');
  });

  it('learns a numeric close-day cadence', () => {
    const led = fold<{ closeDay: number }>([
      [{ closeDay: 8 }, AT0],
      [{ closeDay: 8 }, AT1],
      [{ closeDay: 9 }, AT2],
    ]);
    const r = resolveLedger(led);
    expect(r.value).toEqual({ closeDay: 8 });
    expect(r.observations).toBe(3);
  });
});
