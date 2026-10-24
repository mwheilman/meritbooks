/** Job suggested by location (Clock screen). Pure. */
import type { FieldAssignment, FieldJob, Geo } from './contract';

export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const NEAR_METERS = 500;

export interface Suggestion {
  job: FieldJob;
  why: 'here' | 'visit' | 'only';
  meters: number | null;
}

/**
 * The job to offer first: the job site I am standing at (within 500 m), else the job of my
 * next open visit today, else my only job. Null when there is nothing sensible to guess.
 */
export function suggestJob(jobs: ReadonlyArray<FieldJob>, here: Geo | null, visits: ReadonlyArray<FieldAssignment>, today: string): Suggestion | null {
  if (here) {
    let best: Suggestion | null = null;
    for (const j of jobs) {
      if (j.lat == null || j.lng == null) continue;
      const m = distanceMeters(here, { lat: j.lat, lng: j.lng });
      if (m <= NEAR_METERS + Math.min(here.accuracyM ?? 0, 300) && (!best || m < (best.meters ?? Infinity))) best = { job: j, why: 'here', meters: Math.round(m) };
    }
    if (best) return best;
  }
  const visit = visits.find((v) => v.day === today && v.status !== 'DONE' && v.status !== 'CANCELLED');
  const vj = visit ? jobs.find((j) => j.id === visit.jobId) : undefined;
  if (vj) return { job: vj, why: 'visit', meters: null };
  if (jobs.length === 1) return { job: jobs[0]!, why: 'only', meters: null };
  return null;
}
