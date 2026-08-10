import { describe, it, expect } from 'vitest';
import {
  buildUnbilledAging,
  unbilledBucketFor,
  UNBILLED_BUCKET_ORDER,
  type UnbilledContribution,
} from './unbilled-aging';

const AS_OF = '2026-08-31';

describe('unbilledBucketFor — age by accrual month', () => {
  it('an accrual in the AS-OF month lands in CURRENT ("the month of the underbillings")', () => {
    expect(unbilledBucketFor(AS_OF, '2026-08-01')).toBe('CURRENT');
    expect(unbilledBucketFor(AS_OF, '2026-08-31')).toBe('CURRENT');
    // future-dated (shouldn't happen for posted) is clamped to CURRENT, never negative
    expect(unbilledBucketFor(AS_OF, '2026-09-15')).toBe('CURRENT');
  });

  it('ages by whole months into the successive bands', () => {
    expect(unbilledBucketFor(AS_OF, '2026-07-10')).toBe('1-30');
    expect(unbilledBucketFor(AS_OF, '2026-06-10')).toBe('31-60');
    expect(unbilledBucketFor(AS_OF, '2026-05-10')).toBe('61-90');
    expect(unbilledBucketFor(AS_OF, '2026-04-10')).toBe('90+');
    expect(unbilledBucketFor(AS_OF, '2025-01-10')).toBe('90+');
  });
});

describe('buildUnbilledAging', () => {
  it('empty contributions → empty section (no error, zero total)', () => {
    const r = buildUnbilledAging([], AS_OF);
    expect(r.rows).toEqual([]);
    expect(r.totalCents).toBe(0);
    expect(r.hasAttribution).toBe(false);
    for (const b of UNBILLED_BUCKET_ORDER) expect(r.buckets[b]).toBe(0);
  });

  it('a current-month accrual lands entirely in CURRENT and sums to the total', () => {
    const contribs: UnbilledContribution[] = [
      { customerName: 'Acme Corp', jobId: 'job-1', jobLabel: 'JOB-100 · Roof', entryDate: '2026-08-05', netCents: 500000 },
    ];
    const r = buildUnbilledAging(contribs, AS_OF);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].customerName).toBe('Acme Corp');
    expect(r.rows[0].jobLabel).toBe('JOB-100 · Roof');
    expect(r.rows[0].buckets.CURRENT).toBe(500000);
    expect(r.rows[0].buckets['1-30']).toBe(0);
    expect(r.rows[0].totalCents).toBe(500000);
    expect(r.buckets.CURRENT).toBe(500000);
    expect(r.totalCents).toBe(500000);
    expect(r.hasAttribution).toBe(true);
  });

  it('buckets by entry_date across jobs; every bucket sums to the net GL balance (tie-out)', () => {
    const contribs: UnbilledContribution[] = [
      // Job 1: accrued 3 months back (61-90), then a partial reversal this month (CURRENT).
      { customerName: 'Acme', jobId: 'job-1', jobLabel: 'JOB-1', entryDate: '2026-05-31', netCents: 1000000 },
      { customerName: 'Acme', jobId: 'job-1', jobLabel: 'JOB-1', entryDate: '2026-08-10', netCents: -200000 },
      // Job 2: accrued last month (1-30).
      { customerName: 'Beta', jobId: 'job-2', jobLabel: 'JOB-2', entryDate: '2026-07-15', netCents: 300000 },
    ];
    const r = buildUnbilledAging(contribs, AS_OF);

    // Net GL 1180 balance = 1,000,000 − 200,000 + 300,000 = 1,100,000.
    const bucketSum = UNBILLED_BUCKET_ORDER.reduce((s, b) => s + r.buckets[b], 0);
    expect(bucketSum).toBe(1100000);
    expect(r.totalCents).toBe(1100000);
    // Sum of the displayed row totals equals the overall total.
    expect(r.rows.reduce((s, row) => s + row.totalCents, 0)).toBe(1100000);

    // Job 1 nets 800,000 across its two dated bands; Job 2 sits at 300,000 in 1-30.
    const job1 = r.rows.find((x) => x.jobLabel === 'JOB-1')!;
    expect(job1.buckets['61-90']).toBe(1000000);
    expect(job1.buckets.CURRENT).toBe(-200000);
    expect(job1.totalCents).toBe(800000);
    const job2 = r.rows.find((x) => x.jobLabel === 'JOB-2')!;
    expect(job2.buckets['1-30']).toBe(300000);

    // Sorted most-material first.
    expect(r.rows[0].totalCents).toBe(800000);
  });

  it('a job whose accrual has been fully relieved (nets to zero) drops out of the section', () => {
    const contribs: UnbilledContribution[] = [
      { customerName: 'Acme', jobId: 'job-1', jobLabel: 'JOB-1', entryDate: '2026-06-30', netCents: 400000 },
      { customerName: 'Acme', jobId: 'job-1', jobLabel: 'JOB-1', entryDate: '2026-08-01', netCents: -400000 },
      { customerName: 'Beta', jobId: 'job-2', jobLabel: 'JOB-2', entryDate: '2026-08-01', netCents: 250000 },
    ];
    const r = buildUnbilledAging(contribs, AS_OF);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].jobLabel).toBe('JOB-2');
    expect(r.totalCents).toBe(250000);
  });

  it('lines with no job collapse into a single Unattributed group (hasAttribution=false)', () => {
    const contribs: UnbilledContribution[] = [
      { customerName: null, jobId: null, jobLabel: null, entryDate: '2026-08-02', netCents: 120000 },
      { customerName: null, jobId: null, jobLabel: null, entryDate: '2026-07-02', netCents: 80000 },
    ];
    const r = buildUnbilledAging(contribs, AS_OF);
    expect(r.hasAttribution).toBe(false);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].customerName).toBe('Unattributed');
    expect(r.rows[0].jobLabel).toBeNull();
    expect(r.rows[0].buckets.CURRENT).toBe(120000);
    expect(r.rows[0].buckets['1-30']).toBe(80000);
    expect(r.totalCents).toBe(200000);
  });
});
