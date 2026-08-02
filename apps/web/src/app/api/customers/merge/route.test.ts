import { describe, it, expect } from 'vitest';
import { shouldRepointJobs } from './route';

/**
 * core.jobs.customer_id is a Core-IDENTITY FK (ownership matrix, FILE 2). Books may
 * consolidate it during a customer merge ONLY when it owns core.jobs — i.e. the
 * tenant is standalone (Projects module NOT entitled). When Projects is entitled it
 * authors job identity, so Books leaves the references advisory for the seam.
 */
describe('shouldRepointJobs (customer-merge ownership rule)', () => {
  it('re-points jobs on a STANDALONE tenant that has referencing jobs', () => {
    expect(shouldRepointJobs(false, 3)).toBe(true);
  });

  it('does NOT re-point when Projects is entitled (Core/Projects owns identity)', () => {
    expect(shouldRepointJobs(true, 3)).toBe(false);
  });

  it('is a no-op when there are no referencing jobs, regardless of entitlement', () => {
    expect(shouldRepointJobs(false, 0)).toBe(false);
    expect(shouldRepointJobs(true, 0)).toBe(false);
  });
});
