/** A8 — the seam backlog close signal (pure summary). */
import { describe, it, expect } from 'vitest';
import { seamResolutionKey, summarizeSeamBacklog, SEAM_CLOSE_EVENT_TYPES } from './seam-close-signal';

const ev = (over: Record<string, unknown>) => ({
  id: 'e', event_type: 'JOB_BILLING', status: 'pending', occurred_on: '2026-06-10', created_at: '2026-06-10T00:00:00Z',
  payload: { location_id: 'L1', source_ref: 'pm:bill:1' } as Record<string, unknown>, ...over,
});

describe('seam close signal', () => {
  it('JOB_COST (Books → Projects) is not a Books backlog', () => {
    expect(SEAM_CLOSE_EVENT_TYPES).not.toContain('JOB_COST');
    expect(SEAM_CLOSE_EVENT_TYPES).toEqual(expect.arrayContaining(['JOB_BILLING', 'JOB_COMMITMENT', 'JOB_TIME', 'JOB_PROGRESS']));
  });
  it('keys: commitments by commitment_id, progress by job, the rest by source_ref', () => {
    expect(seamResolutionKey('JOB_COMMITMENT', { commitment_id: 'c', source_ref: 'pm:commit:c:v2' })).toBe('JOB_COMMITMENT|c');
    expect(seamResolutionKey('JOB_PROGRESS', { job_id: 'j' })).toBe('JOB_PROGRESS|j');
    expect(seamResolutionKey('JOB_TIME', { source_ref: 'pm:time:1' })).toBe('JOB_TIME|pm:time:1');
  });
  it('counts per company; a location-less event counts everywhere; a later processed fix settles a rejection', () => {
    const m = summarizeSeamBacklog(['L1', 'L2'], [
      ev({}),
      ev({ id: 'r', status: 'rejected', payload: { location_id: 'L2', source_ref: 'pm:bill:2' } }),
      ev({ id: 'x', status: 'rejected', payload: { source_ref: 'pm:bill:3' } }),
    ], new Map([['JOB_BILLING|pm:bill:3', '2026-06-11T00:00:00Z']]));
    expect(m.get('L1')).toMatchObject({ status: 'BLOCKED', pending: 1, rejected: 0, oldestPendingOn: '2026-06-10' });
    expect(m.get('L2')).toMatchObject({ status: 'BLOCKED', pending: 0, rejected: 1 });
    const clean = summarizeSeamBacklog(['L1'], [], new Map());
    expect(clean.get('L1')).toMatchObject({ status: 'OK', pending: 0 });
  });
});
