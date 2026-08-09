import { describe, it, expect } from 'vitest';
import {
  resolvePeriod,
  deferredRollforward,
  recognitionWaterfallAndMethods,
  loadRevRecReport,
  METHOD_LABEL,
} from './rev-rec-reporting';

// ─────────────────────────────────────────────────────────────────────────────
// resolvePeriod — pure, no DB
// ─────────────────────────────────────────────────────────────────────────────

describe('resolvePeriod', () => {
  it('resolves a normal month with correct last-day boundary', () => {
    const p = resolvePeriod('2026-07');
    expect(p.month).toBe('2026-07');
    expect(p.start).toBe('2026-07-01');
    expect(p.end).toBe('2026-07-31');
    expect(p.label).toBe('July 2026');
  });

  it('resolves February in a non-leap year to the 28th', () => {
    expect(resolvePeriod('2026-02').end).toBe('2026-02-28');
  });

  it('resolves February in a leap year to the 29th', () => {
    expect(resolvePeriod('2024-02').end).toBe('2024-02-29');
  });

  it('resolves December to the 31st', () => {
    const p = resolvePeriod('2026-12');
    expect(p.start).toBe('2026-12-01');
    expect(p.end).toBe('2026-12-31');
  });

  it('falls back to the current month on missing / malformed input', () => {
    for (const bad of [null, undefined, 'garbage', '2026-13-99', '26-1']) {
      const p = resolvePeriod(bad as string | null | undefined);
      expect(p.month).toMatch(/^\d{4}-\d{2}$/);
      expect(p.start).toMatch(/^\d{4}-\d{2}-01$/);
      // start is always the first day of the same month as `month`
      expect(p.start.slice(0, 7)).toBe(p.month);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Minimal in-memory Supabase mock (chainable builder + thenable)
//
// Every builder method returns `this`. Awaiting the builder resolves to the
// array of rows for the current table; `.maybeSingle()` resolves to the single
// `accounts` fixture. This mirrors exactly how the module consumes the client:
// `accounts` is the only .maybeSingle() call; everything else is awaited as a list.
// Row-level filters (.eq/.lte/.in) are intentionally NOT applied — the fixtures
// are pre-scoped to what the real server-side query would return (all POSTED and
// within [<= period.end]), so the module's own JS bucketing is what we exercise.
// ─────────────────────────────────────────────────────────────────────────────

interface Fixtures {
  accounts: Record<string, unknown> | null;
  gl_entry_lines: unknown[];
  revenue_recognition_runs: unknown[];
  jobs: unknown[];
  locations: unknown[];
}

function makeDb(fx: Partial<Fixtures>): any {
  const tables: Record<string, unknown[]> = {
    gl_entry_lines: fx.gl_entry_lines ?? [],
    revenue_recognition_runs: fx.revenue_recognition_runs ?? [],
    jobs: fx.jobs ?? [],
    locations: fx.locations ?? [],
  };
  const accounts = fx.accounts ?? null;

  function builder(table: string) {
    const listResult = { data: tables[table] ?? [], error: null };
    const b: any = {
      schema: () => b,
      select: () => b,
      eq: () => b,
      lte: () => b,
      in: () => b,
      order: () => b,
      limit: () => b,
      maybeSingle: () => Promise.resolve({ data: accounts, error: null }),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(listResult).then(onF, onR),
    };
    return b;
  }

  return {
    schema: (_s: string) => ({ from: (t: string) => builder(t) }),
    from: (t: string) => builder(t),
  };
}

const PERIOD = resolvePeriod('2026-07');

const ACCOUNT_2410 = { id: 'acct-2410', account_number: '2410', name: 'Deferred Revenue' };

const LOCATIONS = [
  { id: 'L1', name: 'Alpha Co', short_code: 'ALP' },
  { id: 'L2', name: 'Beta Co', short_code: 'BET' },
];

// ─────────────────────────────────────────────────────────────────────────────
// deferredRollforward — beginning + additions − recognized = ending
// ─────────────────────────────────────────────────────────────────────────────

describe('deferredRollforward', () => {
  const glLines = [
    // L1 beginning balance: credit 10000 booked before the period
    { debit_cents: 0, credit_cents: 10000, location_id: 'L1', gl_entries: { entry_date: '2026-06-30', status: 'POSTED' } },
    // L1 in-period addition (new deferral, credit) and recognition (debit)
    { debit_cents: 0, credit_cents: 5000, location_id: 'L1', gl_entries: { entry_date: '2026-07-10', status: 'POSTED' } },
    { debit_cents: 3000, credit_cents: 0, location_id: 'L1', gl_entries: { entry_date: '2026-07-20', status: 'POSTED' } },
    // L2 in-period addition only
    { debit_cents: 0, credit_cents: 8000, location_id: 'L2', gl_entries: { entry_date: '2026-07-05', status: 'POSTED' } },
  ];

  it('returns an empty rollforward when the 2410 account is absent', async () => {
    const db = makeDb({ accounts: null, gl_entry_lines: glLines, locations: LOCATIONS });
    const r = await deferredRollforward(db, 'org', { locationId: null, period: PERIOD });
    expect(r.hasAccount).toBe(false);
    expect(r.account).toBeNull();
    expect(r.byCompany).toEqual([]);
    expect(r.total).toEqual({ beginningCents: 0, additionsCents: 0, recognizedCents: 0, endingCents: 0 });
  });

  it('buckets before/in-period lines and ties per company (open + additions − recognized = close)', async () => {
    const db = makeDb({ accounts: ACCOUNT_2410, gl_entry_lines: glLines, locations: LOCATIONS });
    const r = await deferredRollforward(db, 'org', { locationId: null, period: PERIOD });

    expect(r.hasAccount).toBe(true);
    expect(r.account).toEqual({ number: '2410', name: 'Deferred Revenue' });

    const byId = Object.fromEntries(r.byCompany.map((c) => [c.locationId, c]));
    // L1: begin 10000, add 5000, recognized 3000 → end 12000
    expect(byId.L1.beginningCents).toBe(10000);
    expect(byId.L1.additionsCents).toBe(5000);
    expect(byId.L1.recognizedCents).toBe(3000);
    expect(byId.L1.endingCents).toBe(12000);
    expect(byId.L1.name).toBe('Alpha Co');
    // L2: begin 0, add 8000, recognized 0 → end 8000
    expect(byId.L2.endingCents).toBe(8000);

    // Every row ties.
    for (const c of r.byCompany) {
      expect(c.endingCents).toBe(c.beginningCents + c.additionsCents - c.recognizedCents);
    }
  });

  it('totals equal the sum of the per-company rows and tie', async () => {
    const db = makeDb({ accounts: ACCOUNT_2410, gl_entry_lines: glLines, locations: LOCATIONS });
    const r = await deferredRollforward(db, 'org', { locationId: null, period: PERIOD });
    const t = r.total;
    expect(t.beginningCents).toBe(10000);
    expect(t.additionsCents).toBe(13000); // 5000 + 8000
    expect(t.recognizedCents).toBe(3000);
    expect(t.endingCents).toBe(20000); // 12000 + 8000
    expect(t.endingCents).toBe(t.beginningCents + t.additionsCents - t.recognizedCents);
    // total is the reduction of the rows
    expect(t.endingCents).toBe(r.byCompany.reduce((s, c) => s + c.endingCents, 0));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// recognitionWaterfallAndMethods
// ─────────────────────────────────────────────────────────────────────────────

describe('recognitionWaterfallAndMethods', () => {
  const runs = [
    // J1: a June (pre-period) run then a July (in-period) run — earned telescopes.
    { job_id: 'J1', location_id: 'L1', as_of_date: '2026-06-30', method: 'PCT_COSTS_INCURRED', contract_value_cents: 100000, earned_to_date_cents: 40000, recognized_delta_cents: 40000, pct_recognized: 0.4 },
    { job_id: 'J1', location_id: 'L1', as_of_date: '2026-07-31', method: 'PCT_COSTS_INCURRED', contract_value_cents: 100000, earned_to_date_cents: 60000, recognized_delta_cents: 20000, pct_recognized: 0.6 },
    // J2: single in-period milestone run, fully recognized.
    { job_id: 'J2', location_id: 'L2', as_of_date: '2026-07-15', method: 'MILESTONE', contract_value_cents: 50000, earned_to_date_cents: 50000, recognized_delta_cents: 50000, pct_recognized: 1 },
  ];
  const jobs = [
    { id: 'J1', job_number: '100', name: 'Job One', contract_amount_cents: 100000 },
    { id: 'J2', job_number: '200', name: 'Job Two', contract_amount_cents: 50000 },
  ];

  it('waterfall recognized-to-date + remaining ties to the contract value', async () => {
    const db = makeDb({ revenue_recognition_runs: runs, jobs, locations: LOCATIONS });
    const { waterfall } = await recognitionWaterfallAndMethods(db, 'org', { locationId: null, period: PERIOD });

    const byId = Object.fromEntries(waterfall.jobs.map((j) => [j.jobId, j]));
    // J1: cumulative earned telescopes to the latest run's earned_to_date (60000).
    expect(byId.J1.recognizedToDateCents).toBe(60000);
    expect(byId.J1.contractCents).toBe(100000);
    expect(byId.J1.remainingCents).toBe(40000);
    expect(byId.J1.pctRecognized).toBeCloseTo(0.6);
    expect(byId.J1.methodLabel).toBe(METHOD_LABEL.PCT_COSTS_INCURRED);
    expect(byId.J2.recognizedToDateCents).toBe(50000);
    expect(byId.J2.remainingCents).toBe(0);

    // Recognized-to-date + remaining always equals the contract value.
    for (const j of waterfall.jobs) {
      expect(j.recognizedToDateCents + j.remainingCents).toBe(j.contractCents);
    }
  });

  it('sorts jobs by recognized-to-date desc and caps/orders the period columns', async () => {
    const db = makeDb({ revenue_recognition_runs: runs, jobs, locations: LOCATIONS });
    const { waterfall } = await recognitionWaterfallAndMethods(db, 'org', { locationId: null, period: PERIOD });
    expect(waterfall.jobs.map((j) => j.jobId)).toEqual(['J1', 'J2']); // 60000 before 50000
    expect(waterfall.periods).toEqual(['2026-06', '2026-07']); // chronological
    // J1's per-period deltas are bucketed by month.
    expect(waterfall.jobs[0].byPeriod['2026-06']).toBe(40000);
    expect(waterfall.jobs[0].byPeriod['2026-07']).toBe(20000);
  });

  it('method summary counts ONLY in-period deltas and partitions to 100%', async () => {
    const db = makeDb({ revenue_recognition_runs: runs, jobs, locations: LOCATIONS });
    const { methodSummary } = await recognitionWaterfallAndMethods(db, 'org', { locationId: null, period: PERIOD });

    // In July only: PCT delta 20000 (June's 40000 is excluded), MILESTONE 50000.
    expect(methodSummary.totalRecognizedCents).toBe(70000);
    const byMethod = Object.fromEntries(methodSummary.rows.map((r) => [r.method, r]));
    expect(byMethod.PCT_COSTS_INCURRED.recognizedCents).toBe(20000);
    expect(byMethod.PCT_COSTS_INCURRED.jobCount).toBe(1);
    expect(byMethod.MILESTONE.recognizedCents).toBe(50000);

    // Rows partition the total: sum of recognized == total, and pct sums to 1.
    expect(methodSummary.rows.reduce((s, r) => s + r.recognizedCents, 0)).toBe(70000);
    expect(methodSummary.rows.reduce((s, r) => s + r.pct, 0)).toBeCloseTo(1);
    // Ordered biggest-first.
    expect(methodSummary.rows[0].method).toBe('MILESTONE');
  });

  it('returns empty structures when there are no runs', async () => {
    const db = makeDb({ revenue_recognition_runs: [], jobs: [], locations: [] });
    const { waterfall, methodSummary } = await recognitionWaterfallAndMethods(db, 'org', { locationId: null, period: PERIOD });
    expect(waterfall.jobs).toEqual([]);
    expect(waterfall.periods).toEqual([]);
    expect(methodSummary.totalRecognizedCents).toBe(0);
    expect(methodSummary.rows).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loadRevRecReport — combined loader wires the three surfaces together
// ─────────────────────────────────────────────────────────────────────────────

describe('loadRevRecReport', () => {
  it('assembles period + rollforward + waterfall + method summary consistently', async () => {
    const db = makeDb({
      accounts: ACCOUNT_2410,
      gl_entry_lines: [
        { debit_cents: 0, credit_cents: 5000, location_id: 'L1', gl_entries: { entry_date: '2026-07-10', status: 'POSTED' } },
      ],
      revenue_recognition_runs: [
        { job_id: 'J2', location_id: 'L2', as_of_date: '2026-07-15', method: 'MILESTONE', contract_value_cents: 50000, earned_to_date_cents: 50000, recognized_delta_cents: 50000, pct_recognized: 1 },
      ],
      jobs: [{ id: 'J2', job_number: '200', name: 'Job Two', contract_amount_cents: 50000 }],
      locations: LOCATIONS,
    });
    const report = await loadRevRecReport(db, 'org', { locationId: null, month: '2026-07' });
    expect(report.period.month).toBe('2026-07');
    expect(report.rollforward.total.additionsCents).toBe(5000);
    expect(report.waterfall.jobs).toHaveLength(1);
    expect(report.methodSummary.totalRecognizedCents).toBe(50000);
  });
});
