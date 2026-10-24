/**
 * The flux close gate (FPB-financial-reports §5 A-3E.4) — pure.
 *
 * Feeds the blocking `flux_reviewed` task in lib/close/orchestration.ts. It passes when:
 *   • the company's policy does not require a flux review (NOT_REQUIRED), or
 *   • nothing is material this month (NOTHING_MATERIAL), or
 *   • every material line is REVIEWED and not stale (COMPLETE), or
 *   • a controller waived the review with a reason (WAIVED).
 * Otherwise OPEN (blocks). A load failure is UNKNOWN (blocks — fail closed).
 */

import type { FluxCloseSignal, FluxLineStatus, FluxWaiver } from './types';

export interface FluxGateInput {
  reviewRequired: boolean;
  /** Status of each MATERIAL line (non-material lines never gate). */
  materialStatuses: FluxLineStatus[];
  waiver: FluxWaiver | null;
}

export function evaluateFluxGate(input: FluxGateInput): FluxCloseSignal {
  const s = input.materialStatuses;
  const count = (st: FluxLineStatus) => s.filter((x) => x === st).length;
  const reviewed = count('REVIEWED');
  const explained = count('EXPLAINED');
  const stale = count('STALE');
  const unexplained = count('UNEXPLAINED') + count('DRAFT');
  const base = { material: s.length, explained, reviewed, stale, unexplained, waiverReason: null as string | null };

  if (!input.reviewRequired) return { ...base, applicable: false, status: 'NOT_REQUIRED' };
  if (s.length === 0) return { ...base, applicable: true, status: 'NOTHING_MATERIAL' };
  if (reviewed === s.length) return { ...base, applicable: true, status: 'COMPLETE' };
  if (input.waiver?.status === 'WAIVED') return { ...base, applicable: true, status: 'WAIVED', waiverReason: input.waiver.reason };
  return { ...base, applicable: true, status: 'OPEN' };
}

/** The signal used when the flux data could not be read: blocks the close. */
export const FLUX_SIGNAL_UNKNOWN: FluxCloseSignal = {
  applicable: true, status: 'UNKNOWN', material: 0, explained: 0, reviewed: 0, stale: 0, unexplained: 0, waiverReason: null,
};

export function fluxSignalPasses(sig: FluxCloseSignal | null | undefined): boolean {
  if (!sig) return true;
  return sig.status === 'NOT_REQUIRED' || sig.status === 'NOTHING_MATERIAL' || sig.status === 'COMPLETE' || sig.status === 'WAIVED';
}

export const MIN_WAIVER_REASON = 10;
