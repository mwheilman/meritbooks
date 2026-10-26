/**
 * The scheduler's job registry (INT-01 / IA M-12) — the single list of every
 * scheduled job, implemented or not.
 *
 * - Implemented jobs call engines that ALREADY exist (report packs, control
 *   detectors, vendor-compliance maintenance, recurring-JE proposals, rev-rec,
 *   prepaid amortization, Projects event drains; Wave 2E: recurring invoices, the
 *   dunning ladder + late-fee proposals, depreciation / intangible / insurance
 *   amortization, the close opener, the weekly pay-run proposal, digests). Any job that can post to the GL
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
import { runAccessExpirySweepJob } from './jobs/access-jobs';
import { DEALER_MONTH_END_JOB } from './jobs/dealer-jobs';
import { REQUESTS_DISPATCH_JOB } from './jobs/requests-dispatch';
import { REPORT_GOVERNANCE_NIGHTLY_JOB } from '@/lib/reports/governance/job';
import { DOCUMENTS_CLASSIFY_RETRY_JOB } from './jobs/documents-classify-retry';
import { runBankDailyPullJob } from '@/lib/money/plaid-sync';
import { DEALER_CONTROLS_JOB } from './jobs/dealer-controls';
import { runRecurringInvoicesJob } from './jobs/recurring-invoices';
import { runDunningJob } from './jobs/dunning';
import { runLateFeesJob } from './jobs/late-fees';
import { runDepreciationJob, runInsuranceAmortizeJob } from './jobs/depreciation';
import { runPayRunProposeJob } from './jobs/pay-run';
import { runPeriodEndJob } from './jobs/period-end';
import { NOTIFICATIONS_DIGEST_JOB } from './jobs/digest';
// Wave 2 sibling slices (2A vendor W-9/COI, 2B receipts) export their own definitions.
import { RECEIPTS_CHASE_SYNC_JOB, RECEIPTS_DIGEST_JOB } from './jobs/receipts-chase';
import { VENDOR_AI_RECHECK_JOB } from './jobs/vendor-compliance-recheck';
// Wave 4: cash forecast accuracy snapshots (mig 192) and the Merit Projects seam cycle (mig 194).
import { CASH_FORECAST_SNAPSHOT_JOB } from '@/lib/cash/forecast/snapshot-job';
import { PROJECTS_SEAM_JOB } from './jobs/projects-seam-jobs';
import {
  SCHEDULED_DEPRECIATION_FEATURE,
  SCHEDULED_EVENT_DRAIN_FEATURE,
  SCHEDULED_INSURANCE_FEATURE,
  SCHEDULED_PREPAID_FEATURE,
  SCHEDULED_RECURRING_INVOICES_FEATURE,
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
  // Wave 3: report governance (releases / restatement checks) + document intelligence retries.
  REPORT_GOVERNANCE_NIGHTLY_JOB,
  DOCUMENTS_CLASSIFY_RETRY_JOB,
  // Wave 1: requests & chase engine (mig 178) and the nightly Plaid pull (slice 1A).
  REQUESTS_DISPATCH_JOB,
  {
    key: 'bank.daily_pull',
    label: 'Daily bank pull',
    description: 'Nightly incremental Plaid sync for every connected bank of the tenant (stored cursor); flags feeds that have not synced in 48 hours. No GL effect.',
    scope: 'org',
    cron: '0 11 * * *',
    defaultEnabled: true,
    implemented: true,
    ownerCapability: 'bk.feeds',
    owner: 'Bank feed / Plaid',
    postsToGl: false,
    timeoutMs: 120_000,
    maxLatenessMinutes: 6 * 60,
    maxAttempts: 3,
    run: runBankDailyPullJob,
  },
  // Dealer pack (industry module) — no-ops for clients without the pack enabled.
  DEALER_MONTH_END_JOB,
  DEALER_CONTROLS_JOB,
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
    description: 'Expires lapsed W-9/COI documents, advances the chase cadence, and escalates high-risk vendors to Exceptions. W-9/COI reminder emails go out through requests.remind when the tenant switches vendor chase on.',
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
    description: "On the 1st, proposes last month's WIP entry (underbillings to Unbilled AR, overbillings to deferred revenue, loss provisions) for each company set to monthly; posts only when the company is set to auto-post and the Scheduled revenue recognition dial allows it.",
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

  {
    key: 'access.expiry_sweep',
    label: 'Access expiry sweep',
    description: 'Ends access grants whose time box has passed and expires access requests nobody decided within 14 days. Every change lands in the access log. (Expiry reminders wait for the notifications sender.)',
    scope: 'org',
    cron: '0 6 * * *',
    defaultEnabled: true,
    implemented: true,
    ownerCapability: 'ta.access_review',
    owner: 'Access & roles (05-RBAC-SPEC §3.7)',
    postsToGl: false,
    timeoutMs: 60_000,
    maxLatenessMinutes: 12 * 60,
    maxAttempts: 3,
    run: runAccessExpirySweepJob,
  },

  // ── Wave 2E: "make automatic true" (migration 184) ─────────────────────────
  {
    key: 'ar.recurring',
    label: 'Recurring invoices',
    description: 'Daily, generates every recurring invoice that has come due — once per template and period. Each is a draft for review unless its template is set to post (or post and email) AND the "Scheduled recurring invoices" dial allows it under the cap.',
    scope: 'org',
    cron: '0 12 * * *', // ~06:00–07:00 CT
    defaultEnabled: true,
    implemented: true,
    ownerCapability: 'ar.invoices',
    owner: 'Invoices (FPB-invoices D6.1)',
    postsToGl: true,
    autonomyFeature: SCHEDULED_RECURRING_INVOICES_FEATURE,
    timeoutMs: 180_000,
    maxLatenessMinutes: 12 * 60,
    maxAttempts: 3,
    run: runRecurringInvoicesJob,
  },
  {
    key: 'ar.dunning',
    label: 'Payment reminders (dunning ladder)',
    description: "Daily, prepares the next reminder on each company's dunning ladder for every open invoice — stops on payment, promise-to-pay, dispute or an excluded customer. Reminders wait in Requests for a person to send unless the company is set to send and the \"Scheduled payment reminders\" dial allows it; quiet hours and unsubscribes always apply. Off until a dunning policy is switched on.",
    scope: 'org',
    cron: '0 14 * * *', // ~08:00–09:00 CT
    defaultEnabled: true,
    implemented: true,
    ownerCapability: 'ar.collections',
    owner: 'Collections (FPB-invoices D6.2)',
    postsToGl: false,
    timeoutMs: 180_000,
    maxLatenessMinutes: 12 * 60,
    maxAttempts: 3,
    run: runDunningJob,
  },
  {
    key: 'ar.late_fees',
    label: 'Late fees (proposals)',
    description: "Daily, proposes the late fee each overdue invoice owes under the company's late-fee policy (once per invoice per month, never on a fee, never on a disputed invoice). Nothing is charged until a person approves — then one finance-charge invoice per customer. Off until a late-fee policy is switched on.",
    scope: 'org',
    cron: '30 14 * * *',
    defaultEnabled: true,
    implemented: true,
    ownerCapability: 'ar.collections',
    owner: 'Collections (FPB-invoices D6.3)',
    postsToGl: false,
    timeoutMs: 120_000,
    maxLatenessMinutes: 12 * 60,
    maxAttempts: 3,
    run: runLateFeesJob,
  },
  {
    key: 'close.depreciation',
    label: 'Depreciation & amortization (1st of month)',
    description: "On the 1st, works out last month's depreciation (fixed assets) and amortization (intangibles), one line per company. Proposes only, unless the \"Scheduled depreciation & amortization\" dial allows it under the cap; hard-closed months are never touched. Also reports lease periods due (recorded by a person, never automatically).",
    scope: 'org',
    cron: '0 8 1 * *',
    defaultEnabled: true,
    implemented: true,
    ownerCapability: 'ctl.schedules',
    owner: 'Close (fixed assets / intangibles)',
    postsToGl: true,
    autonomyFeature: SCHEDULED_DEPRECIATION_FEATURE,
    timeoutMs: 180_000,
    maxLatenessMinutes: 3 * 24 * 60,
    maxAttempts: 4,
    run: runDepreciationJob,
  },
  {
    key: 'insurance.amortize',
    label: 'Insurance amortization (1st of month)',
    description: 'On the 1st, finds every prepaid-insurance period due through the end of last month. Proposes only, unless the "Scheduled insurance amortization" dial allows it under the cap.',
    scope: 'org',
    cron: '15 8 1 * *',
    defaultEnabled: true,
    implemented: true,
    ownerCapability: 'ctl.schedules',
    owner: 'Close (insurance)',
    postsToGl: true,
    autonomyFeature: SCHEDULED_INSURANCE_FEATURE,
    timeoutMs: 120_000,
    maxLatenessMinutes: 3 * 24 * 60,
    maxAttempts: 4,
    run: runInsuranceAmortizeJob,
  },
  {
    key: 'close.period_end',
    label: 'Open the month-end close',
    description: "Days 2–10 of each month: opens last month's close checklist for every company that has an open period and re-runs the readiness checks (bank recs, AR/AP tie, leakage, exceptions, drafts, approvals). Never posts.",
    scope: 'org',
    cron: '0 13 2-10 * *',
    defaultEnabled: true,
    implemented: true,
    ownerCapability: 'ctl.schedules',
    owner: 'Close (orchestration)',
    postsToGl: false,
    timeoutMs: 180_000,
    maxLatenessMinutes: 12 * 60,
    maxAttempts: 3,
    run: runPeriodEndJob,
  },
  {
    key: 'ap.pay_run_propose',
    label: 'Weekly pay-run proposal',
    description: 'Mondays, drafts a pay run of approved bills due in the next 7 days plus bills whose early-pay discount date falls in that window. Proposal only: it waits in Agents; release prepares approvals, and a second person approves and pays (separation of duties).',
    scope: 'org',
    cron: '0 13 * * 1',
    defaultEnabled: true,
    implemented: true,
    ownerCapability: 'ap.pay_runs',
    owner: 'AP / pay runs (PAY_RUN recipe)',
    postsToGl: false,
    timeoutMs: 60_000,
    maxLatenessMinutes: 24 * 60,
    maxAttempts: 3,
    run: runPayRunProposeJob,
  },
  NOTIFICATIONS_DIGEST_JOB,
  // 2B receipts (migration 181) and 2A vendor certificates (migration 180).
  RECEIPTS_CHASE_SYNC_JOB,
  RECEIPTS_DIGEST_JOB,
  VENDOR_AI_RECHECK_JOB,
  // Wave 4
  CASH_FORECAST_SNAPSHOT_JOB,
  PROJECTS_SEAM_JOB,

  // ── stubs: named in IA §6, not built yet (never run) ───────────────────────
  stub('connectors.sync', 'Connected-system sync', '*/30 * * * *', 'Integrations (07-INTEGRATIONS-PLAN Phase 0)', 'int.sync_runs',
    'TODO(integrations): per-connection incremental sync + nightly reconcile; needs the 07 §1.10 staging/mapping tables and a connector worker.'),
  stub('lenders.prepare', 'Lender reporting drafts', '0 13 * * *', 'Debt & lender reporting (IA M-14)', 'debt.lender_calendar',
    'TODO(M-14): draft compliance certificates / BBC / financial packs N days before each lender obligation is due.'),
  stub('payroll.funding_check', 'Payroll funding check', '0 12 * * 1-5', 'Payroll', 'hr.payroll',
    'TODO(payroll): compare upcoming payroll funding to cash; blocked on the payroll provider decision (task #32).'),
  stub('access.review_campaign', 'Quarterly access review', '0 14 1 1,4,7,10 *', 'Access & roles (05-RBAC-SPEC)', 'ta.access_review',
    'TODO(RBAC): open the quarterly access-review campaign.'),
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
