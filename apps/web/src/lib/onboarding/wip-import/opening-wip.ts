/**
 * Opening WIP computation — PURE. Turns the imported open jobs into the opening WIP
 * schedule and the conversion `subledgerDetail` totals that must TIE to the GL.
 *
 * The recognition MATH is NOT re-derived here — it is delegated to the existing,
 * unit-tested WIP engine (`lib/jobcost/wip.ts`): earned = costs/EAC × contract, then
 * over/under vs billed. This module only:
 *   1. maps ProposedJob[] → WipJobInput[] (effective contract, EAC, costs, billed),
 *   2. rolls the engine's per-job under/over-billings into the three GL ties, and
 *   3. carries retainage + customer deposits through to their control accounts.
 *
 * The tie targets (design spec §4, matched by role in buildGateSubledgerTies):
 *   Σ costs-to-date        → JOB_WIP asset (1210)
 *   Σ under-billings       → UNBILLED_RECEIVABLE / contract asset (1180)
 *   Σ billings-in-excess   → DEFERRED_REVENUE / contract liability (2410)
 *   Σ retainage receivable → RETAINAGE_RECEIVABLE
 *   Σ retainage payable    → RETAINAGE_PAYABLE
 *   Σ customer deposits    → CUSTOMER_DEPOSITS liability (never revenue)
 *
 * INVARIANT: opening onboarding sets the OPENING POSITION only — it never posts a
 * recognition entry (that is the propose-and-approve monthly close, per the spec).
 * All money is integer cents.
 */

import { computeWipSchedule, type WipJobInput, type WipSchedule } from '@/lib/jobcost/wip';
import type { ImportedSubledgerDetail } from '@/lib/onboarding/conversion';
import type { OpeningWipTotals, ProposedJob } from './types';
import { effectiveContractCents } from './normalize';

/** Map imported jobs to the WIP engine's inputs (only jobs with a contract + EAC earn). */
export function toWipJobInputs(jobs: ProposedJob[]): WipJobInput[] {
  return jobs.map((j) => ({
    jobId: j.jobNumber,
    jobNumber: j.jobNumber,
    jobName: j.jobName,
    status: 'ACTIVE',
    company: j.customerName ?? null,
    contractValueCents: effectiveContractCents(j) ?? 0,
    estimatedCostCents: j.estimatedCostCents ?? 0,
    costsToDateCents: j.costsToDateCents ?? 0,
    billedToDateCents: j.billedToDateCents ?? 0,
    pctCompleteOverride: j.pctCompleteOverride,
  }));
}

export interface OpeningWipResult {
  /** The full per-job WIP schedule from the engine (earned / over / under). */
  schedule: WipSchedule;
  /** The subledger totals to stage on the conversion session (ties fire off these). */
  subledgerDetail: ImportedSubledgerDetail;
  /** Convenience roll-up for the review UI. */
  totals: OpeningWipTotals;
}

/**
 * Compute the opening WIP schedule + the conversion `subledgerDetail`. Delegates the
 * earned-revenue / over-under math to the WIP engine; sums retainage + deposits here.
 * Pure and total.
 */
export function computeOpeningWip(jobs: ProposedJob[]): OpeningWipResult {
  const schedule = computeWipSchedule(toWipJobInputs(jobs));

  let retainageReceivableCents = 0;
  let retainagePayableCents = 0;
  let customerDepositsCents = 0;
  for (const j of jobs) {
    retainageReceivableCents += Math.max(0, j.retainageReceivableCents ?? 0);
    retainagePayableCents += Math.max(0, j.retainagePayableCents ?? 0);
    customerDepositsCents += Math.max(0, j.customerDepositsCents ?? 0);
  }

  const t = schedule.totals;

  // Only emit a tie metric when there is detail on that axis — an ABSENT metric adds
  // no blocker (buildGateSubledgerTies skips null), matching the additive tie-out.
  const subledgerDetail: ImportedSubledgerDetail = {
    wipCostsToDateCents: t.costsToDateCents,
    unbilledCents: t.underBillingCents,
    billingsInExcessCents: t.overBillingCents,
  };
  if (retainageReceivableCents > 0) subledgerDetail.retainageReceivableCents = retainageReceivableCents;
  if (retainagePayableCents > 0) subledgerDetail.retainagePayableCents = retainagePayableCents;
  // Customer deposits are a LIABILITY (CUSTOMER_DEPOSITS / 2420), never revenue. Staged
  // as a tie metric only when present so the go-live gate foots them to their control.
  if (customerDepositsCents > 0) subledgerDetail.customerDepositsCents = customerDepositsCents;

  const totals: OpeningWipTotals = {
    jobs: schedule.jobs.length,
    contractValueCents: t.contractValueCents,
    estimatedCostCents: t.estimatedCostCents,
    costsToDateCents: t.costsToDateCents,
    earnedRevenueCents: t.earnedRevenueCents,
    billedToDateCents: t.billedToDateCents,
    unbilledCents: t.underBillingCents,
    billingsInExcessCents: t.overBillingCents,
    retainageReceivableCents,
    retainagePayableCents,
    customerDepositsCents,
    overbilledJobs: t.overbilledJobs,
    underbilledJobs: t.underbilledJobs,
  };

  return { schedule, subledgerDetail, totals };
}

/**
 * Deterministic gate: reasons the WIP import cannot be committed. Empty ⇒ ready.
 * These are the day-one-required facts (design spec §4): each open job needs an
 * identity, a contract value, an EAC (so earned revenue can be computed), and
 * costs-to-date. Duplicate job numbers are rejected (the DB uniqueness would too).
 */
export function wipImportBlockers(jobs: ProposedJob[]): string[] {
  const blockers: string[] = [];
  if (jobs.length === 0) {
    blockers.push('No open jobs to import yet — drop a WIP schedule or a job-cost CSV.');
    return blockers;
  }

  const seen = new Set<string>();
  const dupes = new Set<string>();
  let missingIdentity = 0;
  const missingContract: string[] = [];
  const missingEac: string[] = [];
  const missingCosts: string[] = [];

  for (const j of jobs) {
    if (!j.jobNumber || !j.jobName) { missingIdentity += 1; continue; }
    const key = j.jobNumber.trim().toLowerCase();
    if (seen.has(key)) dupes.add(j.jobNumber); else seen.add(key);
    if (effectiveContractCents(j) == null) missingContract.push(j.jobNumber);
    if (j.estimatedCostCents == null || j.estimatedCostCents <= 0) missingEac.push(j.jobNumber);
    if (j.costsToDateCents == null) missingCosts.push(j.jobNumber);
  }

  if (missingIdentity > 0) blockers.push(`${missingIdentity} job(s) are missing a job number or name.`);
  if (dupes.size > 0) blockers.push(`Duplicate job number(s): ${[...dupes].slice(0, 8).join(', ')}${dupes.size > 8 ? '…' : ''}.`);
  if (missingContract.length > 0) blockers.push(`${missingContract.length} job(s) need a contract value: ${missingContract.slice(0, 8).join(', ')}${missingContract.length > 8 ? '…' : ''}.`);
  if (missingEac.length > 0) blockers.push(`${missingEac.length} job(s) need an estimated total cost (EAC) so earned revenue can be computed: ${missingEac.slice(0, 8).join(', ')}${missingEac.length > 8 ? '…' : ''}.`);
  if (missingCosts.length > 0) blockers.push(`${missingCosts.length} job(s) need costs-to-date: ${missingCosts.slice(0, 8).join(', ')}${missingCosts.length > 8 ? '…' : ''}.`);

  return blockers;
}
