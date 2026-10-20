/**
 * `controls.nightly` — run the Financial Control Exception library for one tenant
 * (IA §6.1 step 11). Every detector is DETECT/PROPOSE-only: it queues PROPOSED
 * ai_decisions rows into /exceptions and never posts, voids, or applies anything.
 * Each detector is idempotent (stable dedup keys), so a re-run queues nothing new.
 *
 * Runs on the per-org RLS-scoped client — the database enforces tenant isolation,
 * exactly as when a controller presses "Scan" on the control screen.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { scanDuplicatePayments } from '@/lib/controls/duplicate-payments';
import { scanAnomalousJournalEntries } from '@/lib/controls/anomalous-je';
import { scanUncategorizedLeakage } from '@/lib/controls/uncategorized-leakage';
import { scanIntercompanyBalance } from '@/lib/controls/intercompany-balance';
import { scanMissedAccruals } from '@/lib/controls/missed-accruals';
import { scanRevenueNotRecognized } from '@/lib/controls/revenue-not-recognized';
import { scanSalesTaxNexus } from '@/lib/controls/sales-tax-nexus';
import { scanCutoffErrors } from '@/lib/controls/cutoff-errors';
import { scanBillAnomalies } from '@/lib/controls/bill-anomaly';
import { scanOutOfPolicyExpenses } from '@/lib/controls/out-of-policy-expense';
import { scanCashApplication } from '@/lib/controls/cash-application';
import type { CountValue, JobContext, JobResult } from '../types';
import { scopedOrFail } from './shared';

interface DetectorSummary {
  queued: number;
  errors?: number;
}

interface Detector {
  key: string;
  run: (db: SupabaseClient, orgId: string) => Promise<DetectorSummary>;
}

/** Exported for the registry test (keeps the list honest). */
export const NIGHTLY_DETECTORS: readonly Detector[] = [
  { key: 'duplicate_payments', run: (db, org) => scanDuplicatePayments(db, org) },
  { key: 'missed_accruals', run: (db, org) => scanMissedAccruals(db, org) },
  { key: 'intercompany_balance', run: (db, org) => scanIntercompanyBalance(db, org) },
  { key: 'uncategorized_leakage', run: (db, org) => scanUncategorizedLeakage(db, org) },
  { key: 'revenue_not_recognized', run: (db, org) => scanRevenueNotRecognized(db, org) },
  { key: 'sales_tax_nexus', run: (db, org) => scanSalesTaxNexus(db, org) },
  { key: 'anomalous_je', run: (db, org) => scanAnomalousJournalEntries(db, org) },
  { key: 'cutoff_errors', run: (db, org) => scanCutoffErrors(db, org) },
  { key: 'bill_anomaly', run: (db, org) => scanBillAnomalies(db, org) },
  { key: 'out_of_policy_expense', run: (db, org) => scanOutOfPolicyExpenses(db, org) },
  { key: 'cash_application', run: (db, org) => scanCashApplication(db, org) },
];

export async function runDetectors(
  db: SupabaseClient,
  orgId: string,
  detectors: readonly Detector[],
  signal: AbortSignal,
): Promise<JobResult> {
  const counts: Record<string, CountValue> = {};
  const failures: string[] = [];
  let queued = 0;
  let ran = 0;
  for (const d of detectors) {
    if (signal.aborted) break;
    try {
      const s = await d.run(db, orgId);
      ran++;
      queued += s.queued;
      counts[d.key] = s.queued;
      if (s.errors) counts[`${d.key}_errors`] = s.errors;
    } catch (e) {
      failures.push(`${d.key}: ${e instanceof Error ? e.message : String(e)}`);
      counts[d.key] = null;
    }
  }
  const status = failures.length === 0 && ran === detectors.length ? 'ok' : ran > 0 ? 'partial' : 'failed';
  return {
    status,
    itemsProcessed: queued,
    counts,
    summary: `Ran ${ran} of ${detectors.length} control checks; ${queued} new exception(s) queued.`,
    error: failures.length ? failures.join('; ') : signal.aborted ? 'stopped at timeout' : undefined,
  };
}

export async function runControlsNightlyJob(ctx: JobContext): Promise<JobResult> {
  const s = scopedOrFail(ctx);
  if (!s.ok) return s.result;
  return runDetectors(s.db, s.orgId, NIGHTLY_DETECTORS, ctx.signal);
}
