import { describe, expect, it } from 'vitest';
import type { FieldAssignment, FieldJob } from './contract';
import { suggestJob } from './geo';

const job = (id: string, lat: number | null, lng: number | null): FieldJob => ({ id, number: id, name: id, companyId: 'c', company: null, customer: null, stage: null, address: null, lat, lng, checklists: [] });
const visit = (jobId: string, day: string): FieldAssignment => ({ id: `v-${jobId}`, jobId, workOrderId: 'w', title: 'Visit', status: 'DISPATCHED', start: null, end: null, day, crew: false });

describe('job suggested by location', () => {
  const jobs = [job('a', 41.5868, -93.625), job('b', 41.7, -93.7), job('c', null, null)];
  it('picks the job site I am standing at', () => {
    expect(suggestJob(jobs, { lat: 41.587, lng: -93.6251, accuracyM: 15 }, [], '2026-10-24')).toMatchObject({ job: { id: 'a' }, why: 'here' });
  });
  it('falls back to my next visit today, then my only job', () => {
    expect(suggestJob(jobs, { lat: 40, lng: -90 }, [visit('b', '2026-10-24')], '2026-10-24')).toMatchObject({ job: { id: 'b' }, why: 'visit' });
    expect(suggestJob([job('z', null, null)], null, [], '2026-10-24')).toMatchObject({ job: { id: 'z' }, why: 'only' });
    expect(suggestJob(jobs, null, [visit('b', '2026-10-25')], '2026-10-24')).toBeNull();
  });
});
