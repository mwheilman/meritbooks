/**
 * Worked examples for the "How do you recognize revenue?" card — PURE. Every number on
 * the card is produced by the canonical engine (wip-engine.ts) from one sample job, so the
 * example can never drift from what the month-end run actually books.
 *
 * Sample: a $100,000 contract, $80,000 estimated cost, $48,000 spent (60% by cost), the
 * project manager reports 60% complete, 3 of 5 milestones accepted, $50,000 billed,
 * $40,000 collected, a 12-month term from Jan 1 measured at Jul 31.
 */

import type { JobRevRecRow, RevRecMethod } from '@/lib/services/rev-rec';
import { computeWipLine, ZERO_BALANCES, type WipLine } from './wip-engine';
import type { CompanyRevRecPolicy } from './policy';

export const EXAMPLE_AS_OF = '2026-07-31';

export const EXAMPLE_JOB: JobRevRecRow & { job_number: string; name: string } = {
  id: 'example-job',
  job_number: 'EX-1',
  name: 'Example job',
  location_id: 'example-company',
  job_type: null,
  archetype: null,
  status: 'ACTIVE',
  rev_rec_method: null,
  rev_rec_method_override: null,
  revenue_account_id: 'revenue',
  contract_amount_cents: 10_000_000,
  estimated_cost_cents: 8_000_000,
  actual_cost_cents: 4_800_000,
  billed_to_date_cents: 5_000_000,
  pct_complete: 60,
  revenue_recognized_cents: 0,
  service_start_date: '2026-01-01',
  service_end_date: '2026-12-31',
  total_milestones: 5,
  completed_milestones: 3,
};

export const EXAMPLE_COLLECTED_CENTS = 4_000_000;

export interface ExampleEntryLine {
  side: 'DR' | 'CR';
  account: string;
  amountCents: number;
}

export interface MethodExample {
  method: RevRecMethod;
  line: WipLine;
  /** One plain-English sentence with the amounts. */
  sentence: string;
  /** The entry the month-end run would book (empty = nothing to accrue). */
  entry: ExampleEntryLine[];
}

const usd = (c: number) =>
  `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;

function lead(method: RevRecMethod, l: WipLine): string {
  const pct = `${Math.round(l.pctComplete * 1000) / 10}%`;
  switch (method) {
    case 'PCT_COSTS_INCURRED': return `If a job has spent ${usd(l.costToDateCents)} of an estimated ${usd(l.eacCents)} (${pct} complete) on a ${usd(l.contractCents)} contract and you've billed ${usd(l.billedCents)},`;
    case 'PCT_COMPLETE': return `If a job is ${pct} complete on a ${usd(l.contractCents)} contract and you've billed ${usd(l.billedCents)},`;
    case 'COMPLETED_CONTRACT': return `If a ${usd(l.contractCents)} job is still in progress and you've billed ${usd(l.billedCents)},`;
    case 'MILESTONE': return `If 3 of 5 milestones are accepted on a ${usd(l.contractCents)} contract and you've billed ${usd(l.billedCents)},`;
    case 'RATABLY':
    case 'SUBSCRIPTION': return `If a ${usd(l.contractCents)} 12-month agreement is ${pct} through its term and you've billed ${usd(l.billedCents)},`;
    case 'CASH': return `If you've billed ${usd(l.billedCents)} and collected ${usd(EXAMPLE_COLLECTED_CENTS)},`;
    case 'AS_BILLED':
    case 'POINT_OF_SALE': return `If you've billed ${usd(l.billedCents)},`;
  }
}

/** The worked example for one method under a policy. Pure. */
export function exampleFor(method: RevRecMethod, policy: Pick<CompanyRevRecPolicy, 'accrueUnderbillings' | 'deferOverbillings'>): MethodExample {
  const line = computeWipLine(
    {
      job: EXAMPLE_JOB,
      method,
      policy: {
        accrueUnderbillings: policy.accrueUnderbillings,
        deferOverbillings: policy.deferOverbillings,
        excluded: false,
        source: { accrueUnderbillings: 'COMPANY', deferOverbillings: 'COMPANY' },
      },
      balances: ZERO_BALANCES,
      collectedToDateCents: EXAMPLE_COLLECTED_CENTS,
    },
    { asOf: EXAMPLE_AS_OF, lossProvision: false, materialityCents: 0 },
  );
  const head = lead(method, line);
  const entry: ExampleEntryLine[] = [];
  let tail: string;
  if (line.targetUnderCents > 0) {
    entry.push({ side: 'DR', account: '1180 Unbilled receivable', amountCents: line.targetUnderCents });
    entry.push({ side: 'CR', account: 'Revenue', amountCents: line.targetUnderCents });
    tail = `you've earned ${usd(line.earnedCents)}, so we'll book ${usd(line.targetUnderCents)} to Unbilled AR (1180) and to revenue, and reverse it on the 1st of next month.`;
  } else if (line.targetOverCents > 0) {
    entry.push({ side: 'DR', account: 'Revenue', amountCents: line.targetOverCents });
    entry.push({ side: 'CR', account: '2410 Deferred revenue', amountCents: line.targetOverCents });
    tail = `you've earned ${usd(line.earnedCents)}, so we'll hold ${usd(line.targetOverCents)} of the billing as Deferred revenue (2410), and reverse it on the 1st of next month.`;
  } else if (line.underCents > 0 || line.overCents > 0) {
    tail = `you've earned ${usd(line.earnedCents)} — but with ${line.underCents > 0 ? 'underbillings' : 'overbillings'} switched off, revenue stays at what you billed.`;
  } else {
    tail = `revenue is ${usd(line.earnedCents)} — exactly what you billed, so there is nothing to accrue.`;
  }
  return { method, line, sentence: `${head} ${tail}`, entry };
}
