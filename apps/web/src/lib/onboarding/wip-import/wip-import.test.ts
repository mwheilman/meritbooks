/**
 * Jobs / WIP onboarding import — pure unit tests.
 *
 * Guards the load-bearing invariants:
 *   1. the deterministic CSV normalizer (dollars→cents, alias auto-map, low-conf flags),
 *   2. the AI-extraction normalizer (whole dollars→cents, blank-on-unknown),
 *   3. earned-revenue / over-under math ties to the shared WIP engine,
 *   4. the opening-WIP totals map to the conversion subledgerDetail (WIP / 1180 / 2410),
 *   5. the import gate (blockers), and
 *   6. the %-completion n/a gating.
 */

import { describe, it, expect } from 'vitest';
import { autoMap } from '@/lib/import/csv';
import { computeWipJob } from '@/lib/jobcost/wip';
import {
  WIP_IMPORT_FIELDS,
  normalizeWipCsvRows,
  normalizeWipExtraction,
  computeOpeningWip,
  wipImportBlockers,
  effectiveContractCents,
  type ProposedJob,
} from './index';
import { wipApplicableForMethods, wipNotApplicable } from '@/lib/onboarding/sections/wip';
import type { OnboardingStatus } from '@/lib/onboarding/status';

// $1,000,000 contract / $800k EAC / $400k costs / $300k billed (underbilled),
// and a second overbilled job — money is CENTS everywhere below.
const CSV_HEADERS = ['Job #', 'Job Name', 'Customer', 'Contract Value', 'Estimated Cost', 'Costs to Date', 'Billed to Date', 'Retainage Receivable', 'Customer Deposit'];
const CSV_ROWS: Record<string, string>[] = [
  { 'Job #': 'J-101', 'Job Name': 'Maple St Custom Home', 'Customer': 'Owner A', 'Contract Value': '1,000,000', 'Estimated Cost': '800,000', 'Costs to Date': '400,000', 'Billed to Date': '300,000', 'Retainage Receivable': '15,000', 'Customer Deposit': '0' },
  { 'Job #': 'J-102', 'Job Name': 'Oak Ave Remodel', 'Customer': 'Owner B', 'Contract Value': '1,000,000', 'Estimated Cost': '800,000', 'Costs to Date': '200,000', 'Billed to Date': '400,000', 'Retainage Receivable': '0', 'Customer Deposit': '25,000' },
];

describe('normalizeWipCsvRows (deterministic column-map)', () => {
  it('auto-maps aliased headers and coerces dollars to cents', () => {
    const mapping = autoMap(CSV_HEADERS, WIP_IMPORT_FIELDS);
    expect(mapping.job_number).toBe('Job #');
    expect(mapping.contract_value_cents).toBe('Contract Value');
    expect(mapping.estimated_cost_cents).toBe('Estimated Cost');

    const { jobs, skipped } = normalizeWipCsvRows(CSV_ROWS, mapping);
    expect(skipped).toHaveLength(0);
    expect(jobs).toHaveLength(2);

    const j1 = jobs[0];
    expect(j1.jobNumber).toBe('J-101');
    expect(effectiveContractCents(j1)).toBe(100_000_000); // $1,000,000
    expect(j1.estimatedCostCents).toBe(80_000_000);
    expect(j1.costsToDateCents).toBe(40_000_000);
    expect(j1.billedToDateCents).toBe(30_000_000);
    expect(j1.retainageReceivableCents).toBe(1_500_000);
    expect(j1.customerDepositsCents).toBe(0);
    expect(j1.source).toBe('heuristic');
    // Fully populated load-bearing fields ⇒ nothing flagged.
    expect(j1.lowConfidenceFields).toHaveLength(0);
  });

  it('flags missing load-bearing fields and skips rows without a job number', () => {
    const mapping = autoMap(CSV_HEADERS, WIP_IMPORT_FIELDS);
    const rows: Record<string, string>[] = [
      { 'Job #': '', 'Job Name': 'orphan total row', 'Contract Value': '5,000' },
      { 'Job #': 'J-200', 'Job Name': 'No EAC job', 'Contract Value': '500,000', 'Billed to Date': '100,000' },
    ];
    const { jobs, skipped } = normalizeWipCsvRows(rows, mapping);
    expect(skipped).toHaveLength(1);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].lowConfidenceFields).toContain('estimatedCostCents');
    expect(jobs[0].lowConfidenceFields).toContain('costsToDateCents');
  });
});

describe('normalizeWipExtraction (AI JSON → cents)', () => {
  it('converts whole dollars to cents and leaves unknowns null', () => {
    const raw = {
      jobs: [
        {
          job_number: 'C-9', job_name: 'Riverside', original_contract: 900000, change_orders: 100000,
          estimated_cost: 800000, costs_to_date: 200000, billed_to_date: 150000,
          confidence: { contract_value: 0.95, estimated_cost: 0.9, costs_to_date: 0.9, billed_to_date: 0.9 },
        },
        { job_number: 'C-10', job_name: 'No numbers', confidence: {} },
      ],
    };
    const jobs = normalizeWipExtraction(raw);
    expect(jobs).toHaveLength(2);
    // original 900k + CO 100k → effective contract $1,000,000.
    expect(effectiveContractCents(jobs[0])).toBe(100_000_000);
    expect(jobs[0].estimatedCostCents).toBe(80_000_000);
    expect(jobs[0].source).toBe('ai');
    // The second job has no figures → all load-bearing fields flagged, none guessed.
    expect(jobs[1].estimatedCostCents).toBeNull();
    expect(jobs[1].lowConfidenceFields).toContain('estimatedCostCents');
    expect(jobs[1].lowConfidenceFields).toContain('contractValueCents');
  });
});

describe('computeOpeningWip — earned / over-under ties to the WIP engine', () => {
  const { jobs } = normalizeWipCsvRows(CSV_ROWS, autoMap(CSV_HEADERS, WIP_IMPORT_FIELDS));
  const opening = computeOpeningWip(jobs);

  it('matches the engine per job (earned = costs/EAC × contract)', () => {
    const engineJ1 = computeWipJob({
      jobId: 'J-101', jobNumber: 'J-101', jobName: 'Maple St Custom Home',
      contractValueCents: 100_000_000, estimatedCostCents: 80_000_000,
      costsToDateCents: 40_000_000, billedToDateCents: 30_000_000,
    });
    const j1 = opening.schedule.jobs.find((j) => j.jobNumber === 'J-101')!;
    expect(j1.earnedRevenueCents).toBe(engineJ1.earnedRevenueCents); // 50% × $1M = $500k
    expect(j1.earnedRevenueCents).toBe(50_000_000);
    expect(j1.underBillingCents).toBe(20_000_000); // earned 500k − billed 300k
    expect(j1.overBillingCents).toBe(0);

    const j2 = opening.schedule.jobs.find((j) => j.jobNumber === 'J-102')!;
    // 25% × $1M = $250k earned; billed $400k ⇒ $150k overbilled.
    expect(j2.earnedRevenueCents).toBe(25_000_000);
    expect(j2.overBillingCents).toBe(15_000_000);
    expect(j2.underBillingCents).toBe(0);
  });

  it('rolls opening totals into the conversion subledgerDetail (WIP / 1180 / 2410)', () => {
    const d = opening.subledgerDetail;
    expect(d.wipCostsToDateCents).toBe(60_000_000);      // Σ costs → JOB_WIP
    expect(d.unbilledCents).toBe(20_000_000);            // Σ under → 1180
    expect(d.billingsInExcessCents).toBe(15_000_000);    // Σ over  → 2410
    expect(d.retainageReceivableCents).toBe(1_500_000);  // Σ retainage rec
    // No retainage payable present ⇒ metric omitted (adds no tie/blocker).
    expect(d.retainagePayableCents).toBeUndefined();

    // Customer deposits are a LIABILITY, tracked in totals, NOT folded into WIP/revenue.
    expect(opening.totals.customerDepositsCents).toBe(2_500_000);
    // …and, being > 0, they are staged as a tie metric so the go-live gate foots them
    // to the CUSTOMER_DEPOSITS control (integrator wiring — conversion.ts + build.ts).
    expect(d.customerDepositsCents).toBe(2_500_000);
    expect(opening.totals.underbilledJobs).toBe(1);
    expect(opening.totals.overbilledJobs).toBe(1);
  });
});

describe('wipImportBlockers (the deterministic import gate)', () => {
  it('is empty for a complete set and flags missing EAC / duplicates', () => {
    const { jobs } = normalizeWipCsvRows(CSV_ROWS, autoMap(CSV_HEADERS, WIP_IMPORT_FIELDS));
    expect(wipImportBlockers(jobs)).toHaveLength(0);

    const bad: ProposedJob[] = [
      { ...jobs[0], estimatedCostCents: null },
      { ...jobs[1], jobNumber: 'J-101' }, // duplicate number
    ];
    const blockers = wipImportBlockers(bad);
    expect(blockers.join(' ')).toMatch(/estimated total cost/i);
    expect(blockers.join(' ')).toMatch(/duplicate/i);
  });

  it('reports the empty case', () => {
    expect(wipImportBlockers([])[0]).toMatch(/no open jobs/i);
  });
});

describe('WIP section applicability (n/a gating off the rev-rec method)', () => {
  it('applies only for %-completion methods', () => {
    expect(wipApplicableForMethods(['PCT_COSTS_INCURRED'])).toBe(true);
    expect(wipApplicableForMethods(['PCT_COMPLETE'])).toBe(true);
    expect(wipApplicableForMethods(['POINT_OF_SALE'])).toBe(false);
    expect(wipApplicableForMethods(['AS_BILLED', 'CASH'])).toBe(false);
    expect(wipApplicableForMethods([])).toBe(false);
  });

  it('marks the section n/a for a non-job business, applicable for a contractor', () => {
    const base = { counts: {}, sections: {} } as unknown as OnboardingStatus;
    expect(wipNotApplicable({ ...base, revRecMethods: ['POINT_OF_SALE'] } as unknown as OnboardingStatus)).toBe(true);
    expect(wipNotApplicable({ ...base, revRecMethods: ['PCT_COSTS_INCURRED'] } as unknown as OnboardingStatus)).toBe(false);
    // Unknown methods ⇒ not hidden (route still enforces).
    expect(wipNotApplicable(base)).toBe(false);
  });
});
