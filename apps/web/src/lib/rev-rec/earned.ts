/**
 * Earned revenue to date, per rev-rec method — PURE (no I/O, no clock). The single
 * authority every recognizer uses (canon §3: rev-rec.ts is the method authority; it
 * re-exports this). All money is integer cents.
 */

import type { JobRevRecRow, RevRecMethod } from '@/lib/services/rev-rec';

/**
 * Earned-revenue-to-date for the resolved method.
 * Returns the cumulative revenue that should be recognized through `asOf`,
 * plus the fraction (0..1) for audit. `collectedToDate` is only used by CASH.
 */
export function earnedToDate(
  method: RevRecMethod,
  job: JobRevRecRow,
  asOf: string,
  collectedToDateCents: number,
): { earnedCents: number; fraction: number } {
  const contract = Number(job.contract_amount_cents ?? 0);
  const estimate = Number(job.estimated_cost_cents ?? 0);
  const actual = Number(job.actual_cost_cents ?? 0);
  const billed = Number(job.billed_to_date_cents ?? 0);
  const done = job.status === 'COMPLETE' || job.status === 'CLOSED';

  const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

  switch (method) {
    case 'PCT_COSTS_INCURRED': {
      const f = estimate > 0 ? clamp01(actual / estimate) : 0;
      return { earnedCents: Math.round(contract * f), fraction: f };
    }
    case 'PCT_COMPLETE': {
      const f = clamp01(Number(job.pct_complete ?? 0) / 100);
      return { earnedCents: Math.round(contract * f), fraction: f };
    }
    case 'COMPLETED_CONTRACT':
      return { earnedCents: done ? contract : 0, fraction: done ? 1 : 0 };
    case 'RATABLY':
    case 'SUBSCRIPTION': {
      if (job.service_start_date && job.service_end_date) {
        const s = new Date(`${job.service_start_date}T00:00:00Z`).getTime();
        const e = new Date(`${job.service_end_date}T00:00:00Z`).getTime();
        const now = new Date(`${asOf}T00:00:00Z`).getTime();
        const f = e > s ? clamp01((now - s) / (e - s)) : (now >= e ? 1 : 0);
        return { earnedCents: Math.round(contract * f), fraction: f };
      }
      return { earnedCents: billed, fraction: contract > 0 ? clamp01(billed / contract) : 0 };
    }
    case 'MILESTONE': {
      // Accepted milestones earn their share of the contract when the job tracks them;
      // otherwise revenue follows billing (each milestone is billed on acceptance).
      const total = Number(job.total_milestones ?? 0);
      if (total > 0 && contract > 0) {
        const f = done ? 1 : clamp01(Number(job.completed_milestones ?? 0) / total);
        return { earnedCents: Math.round(contract * f), fraction: f };
      }
      return { earnedCents: billed, fraction: contract > 0 ? clamp01(billed / contract) : 0 };
    }
    case 'POINT_OF_SALE':
    case 'AS_BILLED':
      // Point-in-time / billing-based: revenue follows what's been billed.
      return { earnedCents: billed, fraction: contract > 0 ? clamp01(billed / contract) : 0 };
    case 'CASH':
      return { earnedCents: collectedToDateCents, fraction: contract > 0 ? clamp01(collectedToDateCents / contract) : 0 };
    default:
      return { earnedCents: 0, fraction: 0 };
  }
}
