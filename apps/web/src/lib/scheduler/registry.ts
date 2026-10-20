/**
 * The scheduler's job registry (INT-01 / IA M-12) — the single list of every
 * scheduled job, implemented or not.
 *
 * - Implemented jobs call engines that ALREADY exist (report packs, control
 *   detectors, vendor-compliance maintenance, recurring-JE proposals, rev-rec,
 *   prepaid amortization, Projects event drains). Any job that can post to the GL
 *   goes through the tenant's autonomy dial first (posting-gate.ts) and only
 *   PROPOSES unless the dial allows.
 * - Stubs (`implemented: false`) are the future jobs IA §6 names. They are listed
 *   so the Automation-health widget can show "not running yet" honestly, and so
 *   the job key is reserved. A stub NEVER runs, whatever core.scheduled_jobs says.
 *
 * Crons are UTC. Merit's tenants are US Central (UTC-5/-6), so 08:10 UTC ≈ 02:10–03:10 CT.
 *
 * Adding a job: see docs/SCHEDULER.md ("How to add a job").
 */

import type { JobDefinition } from './types';
import { runReportPacksJob } from './jobs/report-packs';
import { runControlsNightlyJob } from './jobs/controls-nightly';
import { runRecurringJeProposeJob, runVendorComplianceScanJob } from './jobs/proposal-jobs';
import { runEventsDrainJob, runPrepaidAmortizeJob, runRevRecMonthlyJob } from './jobs/gl-gated-jobs';
import { runPruneRunsJob } from './jobs/platform-jobs';
import {
  SCHEDULED_EVENT_DRAIN_FEATURE,
  SCHEDULED_PREPAID_FEATURE,
  SCHEDULED_REV_REC_FEATURE,
} from './posting-gate';

const MIN = 60_000;

/** Defaults for a registered-but-not-built job. */
function stub(
  key: string,
  label: string,
  cron: string,
  owner: string,
  ownerCapability: string,
  todo: string,
  postsToGl = false,
): JobDefinition {
  return {
    key,
    label,
    description: todo,
    scope: 'org',
    cron,
    defaultEnabled: false,
    implemented: false,
    ownerCapability,
    owner,
    postsToGl,
    timeoutMs: 60_000,
    maxLatenessMinutes: 6 * 60,
    maxAttempts: 3,
    todo,
  };
}

export const JOBS: readonly JobDefinition[] = [
  // ── implemented ────────────────────────────────────────────────────────────
  {
    key: 'reports.packs',
    label: 'Scheduled report packs',
    description: 'Emails every report pack a user scheduled whose next run date has arrived.',
    scope: 'org',
    cron: '0 12 * * *', // ~06:00–07:00 CT
    defaultEnabled: true,
    implemented: true,
    ownerCapability: 'reports.packs',
    owner: 'Reports (FPB-reports-fpna §5.2)',
    postsToGl: false,
    timeoutMs: 120_000,
    maxLatenessMinutes: 12 * 60,
    maxAttempts: 3,
    run: runReportPacksJob,
  },
  {
    key: 'controls.nightly',
    label: 'Nightly control checks',
    description: 'Runs the financial-control exception detectors (duplicates, accruals, cutoff, leakage, rev-rec, nexus, …) and queues new findings in Exceptions. Detect-only.',
    scope: 'org',
    cron: '10 8 * * *', // ~02:10–03:10 CT
    defaultEnabled: true,
    implemented: true,
    ownerCapability: 'ctl.exceptions',
    owner: 'Controls (FPB-financial-control-exceptions)',
    postsToGl: false,
    timeoutMs: 120_000,
    maxLatenessMinutes: 12 * 60,
    maxAttempts: 3,
    run: runControlsNightlyJob,
  },
  {
    key: 'vendors.compliance_scan',
    label: 'Vendor compliance scan',
    description: 'Expires lapsed W-9/COI documents, advances the chase cadence, and escalates high-risk vendors to Exceptions. Sends nothing yet (see requests.remind).',
    scope: 'org',
    cron: '30 8 * * *',
    defaultEnabled: true,
    implemented: true,
    ownerCapability: 'vc.expiring',
    owner: 'Vendor compliance (FPB-vendor-compliance-chase)',
    postsToGl: false,
    timeoutMs: 60_000,
    maxLatenessMinutes: 12 * 60,
    maxAttempts: 3,
    run: runVendorComplianceScanJob,
  },
  {
    key: 'recurring_je.propose',
    label: 'Recurring journal entries',
    description: 'Stages every due recurring-entry period as a proposal for a human to approve and post. Never posts.',
    scope: 'org',
    cron: '0 9 * * *',
    defaultEnabled: true,
    implemented: true,
    ownerCapability: 'ctl.schedules',
    owner: 'Close (recurring JE)',
    postsToGl: false,
    timeoutMs: 60_000,
    maxLatenessMinutes: 12 * 60,
    maxAttempts: 3,
    run: runRecurringJeProposeJob,
  },
  {
    key: 'revrec.monthly',
    label: 'Revenue recognition (1st of month)',
    description: 'On the 1st, previews recognition through month-end for every eligible job. Proposes only, unless the tenant set the "Scheduled revenue recognition" dial to auto-under-limit.',
    scope: 'org',
    cron: '0 7 1 * *',
    defaultEnabled: true,
    implemented: true,
    ownerCapability: 'rr.recognition',
    owner: 'Revenue recognition',
    postsToGl: true,
    autonomyFeature: SCHEDULED_REV_REC_FEATURE,
    timeoutMs: 120_000,
    maxLatenessMinutes: 3 * 24 * 60,
    maxAttempts: 4,
    run: runRevRecMonthlyJob,
  },
  {
    key: 'prepaid.amortize',
    label: 'Prepaid amortization',
    description: 'Monthly, finds every due prepaid amortization period. Proposes only, unless the tenant set the "Scheduled prepaid amortization" dial to auto-under-limit.',
    scope: 'org',
    cron: '30 7 1 * *',
    defaultEnabled: true,
    implemented: true,
    ownerCapability: 'ctl.schedules',
    owner: 'Close (prepaids)',
    postsToGl: true,
    autonomyFeature: SCHEDULED_PREPAID_FEATURE,
    timeoutMs: 60_000,
    maxLatenessMinutes: 3 * 24 * 60,
    maxAttempts: 4,
    run: runPrepaidAmortizeJob,
  },
  {
    key: 'events.drain',
    label: 'Projects event drain',
    description: 'Hourly, checks pending Projects → Books events (billing, internal invoices, progress). They wait for a human unless the "Scheduled Projects event drain" dial allows.',
    scope: 'org',
    cron: '20 * * * *',
    defaultEnabled: true,
    implemented: true,
    ownerCapability: 'journal_entries.post',
    owner: 'Books event consumers (FROZEN v3 contract)',
    postsToGl: true,
    autonomyFeature: SCHEDULED_EVENT_DRAIN_FEATURE,
    timeoutMs: 90_000,
    maxLatenessMinutes: 55,
    maxAttempts: 2,
    run: runEventsDrainJob,
  },
  {
    key: 'scheduler.prune_runs',
    label: 'Run-log retention',
    description: 'Deletes scheduler run-log rows older than 90 days.',
    scope: 'platform',
    cron: '0 10 * * *',
    defaultEnabled: true,
    implemented: true,
    ownerCapability: 'platform.health',
    owner: 'Platform',
    postsToGl: false,
    timeoutMs: 30_000,
    maxLatenessMinutes: 12 * 60,
    maxAttempts: 3,
    run: runPruneRunsJob,
  },

  // ── stubs: named in IA §6, not built yet (never run) ───────────────────────
  stub('bank.daily_pull', 'Daily bank pull', '0 11 * * *', 'Bank feed / Plaid', 'bk.feeds',
    'TODO(bank feed): incremental Plaid /transactions/sync per item using the stored cursor (mig 046); today pulls are user-triggered.'),
  stub('connectors.sync', 'Connected-system sync', '*/30 * * * *', 'Integrations (07-INTEGRATIONS-PLAN Phase 0)', 'int.sync_runs',
    'TODO(integrations): per-connection incremental sync + nightly reconcile; needs the 07 §1.10 staging/mapping tables and a connector worker.'),
  stub('requests.remind', 'Request reminders', '0 14 * * *', 'Requests & chase engine (IA M-7)', 'bk.requests_out',
    'TODO(M-7): send due reminders for client questions, receipt chase (cadence 0/2/5/10 days, quiet hours) and vendor-document chase; needs the request engine + an email/SMS sender.'),
  stub('ap.pay_run_propose', 'Pay-run proposal', '0 13 * * 1-5', 'AP / pay runs', 'ap.pay_runs',
    'TODO(AP): draft a pay run by due date and discount from the pay-run agent recipe; proposal only, release stays human.'),
  stub('ar.recurring', 'Recurring invoices', '0 12 * * *', 'Invoices', 'ar.invoices',
    'TODO(invoices): generateDueRecurringInvoices issues invoices and posts AR directly; needs a draft/propose mode (or the autonomy gate) before it may run unattended.', true),
  stub('ar.dunning', 'Collections dunning drafts', '0 15 * * 1-5', 'Collections', 'ar.collections',
    'TODO(collections): draft dunning messages from the worklist + cadence; sending stays human until approve-before-send exists.'),
  stub('close.period_end', 'Period-end engines', '0 8 1 * *', 'Close (period engine)', 'ctl.schedules',
    'TODO(close): /api/period-engine posts recurring JEs, schedules and depreciation directly; needs a preview/proposal mode before it may be scheduled.', true),
  stub('lenders.prepare', 'Lender reporting drafts', '0 13 * * *', 'Debt & lender reporting (IA M-14)', 'debt.lender_calendar',
    'TODO(M-14): draft compliance certificates / BBC / financial packs N days before each lender obligation is due.'),
  stub('payroll.funding_check', 'Payroll funding check', '0 12 * * 1-5', 'Payroll', 'hr.payroll',
    'TODO(payroll): compare upcoming payroll funding to cash; blocked on the payroll provider decision (task #32).'),
  stub('access.expiry_sweep', 'Access expiry sweep', '0 6 * * *', 'Access & roles (05-RBAC-SPEC)', 'ta.access_review',
    'TODO(RBAC R-4): reminders 7d/1d before an access assignment ends and deactivation at effective_to.'),
  stub('access.review_campaign', 'Quarterly access review', '0 14 1 1,4,7,10 *', 'Access & roles (05-RBAC-SPEC)', 'ta.access_review',
    'TODO(RBAC): open the quarterly access-review campaign.'),
  stub('notifications.digest', 'Notification digests', '0 13 * * *', 'Notifications & watch rules (IA M-13)', 'home.workspace',
    'TODO(M-13): evaluate watch rules and send daily/weekly digests; needs notification preferences + a sender.'),
  stub('reports.post_close_bva', 'Post-close budget vs. actual', '0 14 * * *', 'FP&A (FPB-reports-fpna §5.2)', 'reports.packs',
    'TODO(FP&A): after a hard close, push budget-vs-actual to owners and snapshot the forecast.'),
];

const JOB_MAP: ReadonlyMap<string, JobDefinition> = new Map(JOBS.map((j) => [j.key, j]));

export function getJob(key: string): JobDefinition | undefined {
  return JOB_MAP.get(key);
}

/** UI-safe catalog (no functions). */
export interface JobSummary {
  key: string;
  label: string;
  description: string;
  scope: JobDefinition['scope'];
  cron: string;
  defaultEnabled: boolean;
  implemented: boolean;
  owner: string;
  ownerCapability: string;
  postsToGl: boolean;
  autonomyFeature: string | null;
}

export function listJobSummaries(): JobSummary[] {
  return JOBS.map((j) => ({
    key: j.key,
    label: j.label,
    description: j.description,
    scope: j.scope,
    cron: j.cron,
    defaultEnabled: j.defaultEnabled,
    implemented: j.implemented,
    owner: j.owner,
    ownerCapability: j.ownerCapability,
    postsToGl: j.postsToGl,
    autonomyFeature: j.autonomyFeature ?? null,
  }));
}
