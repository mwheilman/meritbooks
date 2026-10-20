/**
 * Scheduled jobs whose engines CAN post to the GL. Each one first computes what it
 * WOULD post (a preview), then asks the tenant's autonomy dial (posting-gate.ts):
 *
 *   dial PROPOSE / OFF / kill switch  → record the preview as a proposal in the run
 *                                       log; a human posts from the module screen.
 *   dial AUTO_UNDER_LIMIT, total ≤ cap → the scheduled run posts through the same
 *                                       engine the module's "Run" button uses (all
 *                                       its guards apply: balance, period lock,
 *                                       idempotent run ledgers).
 *
 *   revrec.monthly    on the 1st, recognize through the last day of the prior month.
 *   prepaid.amortize  monthly, post every due prepaid amortization period.
 *   events.drain      hourly, process pending Projects → Books events (FROZEN v3).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { recognizeRun } from '@/lib/services/rev-rec';
import { runPrepaidAmortizations } from '@/lib/prepaid/amortize';
import { buildAmortizationSchedule } from '@/lib/prepaid/schedule';
import { processBillingEvents } from '@/lib/services/billing-consumer';
import { processDeptInvoiceEvents } from '@/lib/services/dept-invoice-consumer';
import { processProgressEvents } from '@/lib/services/job-progress';
import {
  postingGate,
  SCHEDULED_EVENT_DRAIN_FEATURE,
  SCHEDULED_PREPAID_FEATURE,
  SCHEDULED_REV_REC_FEATURE,
} from '../posting-gate';
import type { CountValue, JobContext, JobResult } from '../types';
import { dollars, isoDate, lastDayOfPriorMonth, scopedOrFail } from './shared';

// ── revrec.monthly ───────────────────────────────────────────────────────────

export async function runRevRecMonthlyJob(ctx: JobContext): Promise<JobResult> {
  const s = scopedOrFail(ctx);
  if (!s.ok) return s.result;
  const asOf = lastDayOfPriorMonth(ctx.slotAt);

  const preview = await recognizeRun(s.db, s.orgId, { asOf, runBy: null, preview: true });
  const pending = preview.jobs.filter((j) => j.status === 'posted' && j.deltaCents !== 0);
  const totalAbs = pending.reduce((sum, j) => sum + Math.abs(j.deltaCents), 0);
  const net = pending.reduce((sum, j) => sum + j.deltaCents, 0);
  if (pending.length === 0) {
    return { status: 'ok', itemsProcessed: 0, counts: { as_of: asOf, jobs: preview.jobs.length }, summary: `Revenue is up to date through ${asOf}.` };
  }

  const gate = await postingGate(ctx.admin, s.orgId, SCHEDULED_REV_REC_FEATURE, totalAbs);
  if (!gate.allowed) {
    return {
      status: 'ok',
      itemsProcessed: 0,
      counts: { as_of: asOf, mode: 'proposed', jobs_to_recognize: pending.length, net_delta_cents: net, gate: gate.disposition },
      summary: `Proposed: ${pending.length} job(s) would recognize ${dollars(net)} through ${asOf}. Review and post it from Revenue recognition. (${gate.reason})`,
    };
  }

  const run = await recognizeRun(s.db, s.orgId, { asOf, runBy: null, preview: false });
  return {
    status: 'ok',
    itemsProcessed: run.posted,
    counts: { as_of: asOf, mode: 'posted', posted: run.posted, unchanged: run.unchanged, skipped: run.skipped, net_delta_cents: run.totalRecognizedDeltaCents },
    summary: `Posted rev-rec for ${run.posted} job(s), ${dollars(run.totalRecognizedDeltaCents)} through ${asOf} (within your auto-post limit).`,
  };
}

// ── prepaid.amortize ─────────────────────────────────────────────────────────

interface PrepaidScheduleRow {
  id: string;
  total_cents: number | string;
  months: number;
  start_date: string;
  periods_posted: number;
}

/** What runPrepaidAmortizations WOULD post through `asOf` (same due rule, no writes). */
export async function previewPrepaidDue(
  db: SupabaseClient,
  asOf: string,
): Promise<{ schedules: number; periods: number; amountCents: number }> {
  const { data, error } = await db
    .from('posting_schedules')
    .select('id, total_cents, months, start_date, periods_posted')
    .eq('schedule_type', 'PREPAID_AMORTIZATION')
    .eq('status', 'ACTIVE');
  if (error) throw new Error(error.message);
  const d = new Date(`${asOf}T00:00:00Z`);
  const cutoff = d.getUTCFullYear() * 12 + d.getUTCMonth();
  let periods = 0;
  let amountCents = 0;
  let schedules = 0;
  for (const s of (data ?? []) as PrepaidScheduleRow[]) {
    let lines;
    try {
      lines = buildAmortizationSchedule({ totalCents: Number(s.total_cents), startDate: s.start_date, months: s.months });
    } catch {
      continue; // the engine reports un-buildable schedules itself
    }
    let due = 0;
    for (let idx = s.periods_posted; idx < s.months; idx++) {
      const line = lines[idx];
      if (!line || line.year * 12 + (line.month - 1) > cutoff) break;
      due++;
      amountCents += line.amountCents;
    }
    if (due > 0) schedules++;
    periods += due;
  }
  return { schedules, periods, amountCents };
}

export async function runPrepaidAmortizeJob(ctx: JobContext): Promise<JobResult> {
  const s = scopedOrFail(ctx);
  if (!s.ok) return s.result;
  const asOf = isoDate(ctx.now);
  const due = await previewPrepaidDue(s.db, asOf);
  if (due.periods === 0) {
    return { status: 'ok', itemsProcessed: 0, counts: { as_of: asOf }, summary: 'No prepaid amortization is due.' };
  }

  const gate = await postingGate(ctx.admin, s.orgId, SCHEDULED_PREPAID_FEATURE, due.amountCents);
  if (!gate.allowed) {
    return {
      status: 'ok',
      itemsProcessed: 0,
      counts: { as_of: asOf, mode: 'proposed', schedules: due.schedules, periods_due: due.periods, amount_cents: due.amountCents, gate: gate.disposition },
      summary: `Proposed: ${due.periods} prepaid period(s) across ${due.schedules} schedule(s), ${dollars(due.amountCents)}, are due. Post them from Prepaids. (${gate.reason})`,
    };
  }

  const run = await runPrepaidAmortizations(s.db, s.orgId, { asOf });
  const failed = run.errors.length;
  return {
    status: failed === 0 ? 'ok' : run.periods_posted > 0 ? 'partial' : 'failed',
    itemsProcessed: run.periods_posted,
    counts: { as_of: asOf, mode: 'posted', periods_posted: run.periods_posted, amount_cents: run.amount_posted_cents, completed: run.completed, errors: failed },
    summary: `Posted ${run.periods_posted} prepaid period(s), ${dollars(run.amount_posted_cents)} (within your auto-post limit).`,
    error: failed ? run.errors.map((e) => `${e.schedule_id} ${e.period}: ${e.error}`).join('; ') : undefined,
  };
}

// ── events.drain ─────────────────────────────────────────────────────────────

interface PendingEventRow {
  payload: { lines?: Array<{ amount_cents?: number | string | null }> } | null;
}

interface PendingSummary {
  count: number;
  /** Sum of line amounts, or null when the event type carries no amount. */
  amountCents: number | null;
}

async function pendingFor(
  admin: SupabaseClient,
  orgId: string,
  eventType: string,
  opts: { sourceModule?: string; withAmount: boolean },
): Promise<PendingSummary> {
  let q = admin
    .schema('core')
    .from('events')
    .select('payload')
    .eq('org_id', orgId)
    .eq('event_type', eventType)
    .eq('status', 'pending');
  if (opts.sourceModule) q = q.eq('source_module', opts.sourceModule);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as PendingEventRow[];
  if (!opts.withAmount) return { count: rows.length, amountCents: null };
  const amountCents = rows.reduce(
    (sum, r) => sum + (r.payload?.lines ?? []).reduce((s, l) => s + Math.abs(Math.round(Number(l.amount_cents ?? 0))), 0),
    0,
  );
  return { count: rows.length, amountCents };
}

export async function runEventsDrainJob(ctx: JobContext): Promise<JobResult> {
  if (!ctx.orgId) return { status: 'skipped', summary: 'Event drains run per tenant.' };
  const orgId = ctx.orgId;
  // The drains are given the service-role client exactly as their routes do: every
  // read/insert/post inside them is pinned to the event's own org_id, and we pass
  // orgFilter so this run only ever touches THIS tenant's queue.
  const admin = ctx.admin;

  const billing = await pendingFor(admin, orgId, 'JOB_BILLING', { withAmount: true });
  const dept = await pendingFor(admin, orgId, 'DEPT_INVOICE_ISSUE', { sourceModule: 'projects', withAmount: true });
  const progress = await pendingFor(admin, orgId, 'JOB_PROGRESS', { withAmount: false });
  const totalPending = billing.count + dept.count + progress.count;
  if (totalPending === 0) return { status: 'ok', itemsProcessed: 0, summary: 'No Projects events pending.' };

  const counts: Record<string, CountValue> = {
    billing_pending: billing.count,
    dept_invoice_pending: dept.count,
    progress_pending: progress.count,
  };
  const failures: string[] = [];
  const waiting: string[] = [];
  let processed = 0;

  const drains: Array<{
    label: string;
    key: string;
    pending: PendingSummary;
    run: () => Promise<{ processed: number; rejected: number }>;
  }> = [
    { label: 'job billing', key: 'billing', pending: billing, run: () => processBillingEvents(admin, orgId) },
    { label: 'internal invoice', key: 'dept_invoice', pending: dept, run: () => processDeptInvoiceEvents(admin, orgId) },
    // Progress events recognize revenue for an amount only known after recognition,
    // so the gate sees amount=null and never auto-posts them (a human drains them).
    { label: 'job progress', key: 'progress', pending: progress, run: () => processProgressEvents(admin, orgId, null) },
  ];

  for (const d of drains) {
    if (d.pending.count === 0 || ctx.signal.aborted) continue;
    const gate = await postingGate(admin, orgId, SCHEDULED_EVENT_DRAIN_FEATURE, d.pending.amountCents);
    counts[`${d.key}_gate`] = gate.disposition;
    if (!gate.allowed) {
      waiting.push(`${d.pending.count} ${d.label}`);
      continue;
    }
    try {
      const r = await d.run();
      processed += r.processed;
      counts[`${d.key}_processed`] = r.processed;
      counts[`${d.key}_rejected`] = r.rejected;
    } catch (e) {
      failures.push(`${d.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const parts: string[] = [];
  if (processed > 0) parts.push(`Processed ${processed} event(s).`);
  if (waiting.length > 0) parts.push(`Waiting for a human to process: ${waiting.join(', ')} event(s) (autonomy dial).`);
  return {
    status: failures.length === 0 ? 'ok' : processed > 0 ? 'partial' : 'failed',
    itemsProcessed: processed,
    counts,
    summary: parts.join(' ') || 'No Projects events processed.',
    error: failures.length ? failures.join('; ') : undefined,
  };
}
