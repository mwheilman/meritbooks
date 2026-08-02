/**
 * Collections worklist — prioritized, per-account ranking with a recommended
 * next action. PURE (no I/O, no clock): the route hydrates rows + the customer
 * dossier + logged promises and hands them here; this module ranks and decides.
 *
 * Ranking intent (task + FPB): chase the accounts that cost the most to leave
 * uncollected. Score = overdue dollars × age factor × risk multiplier, with a
 * boost for a broken promise-to-pay (the strongest short-of-write-off signal).
 * The recommended action is derived deterministically from cadence stage, risk,
 * and promise state — the AI only phrases the letter, never picks the action.
 */

import { cadenceStageForDays, decideReminder, type DunningStage, type DunningStageKey } from './cadence';
import type { ClassifiedPromise } from './promises';

export type RiskLevel = 'low' | 'medium' | 'high';

/** One overdue open invoice feeding the worklist. */
export interface WorklistInvoiceInput {
  id: string;
  invoiceNumber: string;
  dueDate: string; // YYYY-MM-DD
  balanceCents: number;
  daysOverdue: number;
  /** Most severe dunning stage already sent for this invoice, or null. */
  lastStageSent: DunningStageKey | null;
  lastReminderAt: string | null;
  reminderCount: number;
}

export interface WorklistAccountInput {
  customerId: string | null;
  customerName: string;
  customerEmail: string | null;
  /** Deterministic risk from the customer dossier (read-only reuse). */
  riskLevel: RiskLevel;
  riskFlags: string[];
  riskSummary: string;
  avgDaysBeyondTerms: number | null;
  openBalanceCents: number;
  overdueBalanceCents: number;
  invoices: WorklistInvoiceInput[];
  /** Classified promises for this account (pending/kept/broken). */
  promises: ClassifiedPromise[];
}

export type RecommendedActionKind =
  | 'AWAIT_PROMISE'
  | 'CALL_BROKEN_PROMISE'
  | 'SEND_FIRST_NOTICE'
  | 'SEND_SECOND_NOTICE'
  | 'SEND_THIRD_NOTICE'
  | 'SEND_FINAL_NOTICE'
  | 'ESCALATE'
  | 'MONITOR';

export interface RecommendedAction {
  kind: RecommendedActionKind;
  label: string;
  reason: string;
  /** The cadence stage to draft, when the action is to send a notice. */
  stage: DunningStageKey | null;
}

export interface WorklistAccount {
  customerId: string | null;
  customerName: string;
  customerEmail: string | null;
  riskLevel: RiskLevel;
  riskFlags: string[];
  riskSummary: string;
  openBalanceCents: number;
  overdueBalanceCents: number;
  overdueInvoiceCount: number;
  maxDaysOverdue: number;
  /** The single invoice driving the recommended action (oldest/largest overdue). */
  focusInvoiceId: string | null;
  hasBrokenPromise: boolean;
  hasPendingPromise: boolean;
  pendingPromise: ClassifiedPromise | null;
  brokenPromiseCount: number;
  currentStage: DunningStageKey | null;
  reminderDue: boolean;
  recommendedAction: RecommendedAction;
  priorityScore: number;
  invoices: WorklistInvoiceInput[];
  promises: ClassifiedPromise[];
}

const RISK_MULTIPLIER: Record<RiskLevel, number> = { low: 1.0, medium: 1.35, high: 1.8 };

const STAGE_ACTION: Record<DunningStageKey, { kind: RecommendedActionKind; label: string }> = {
  FIRST_NOTICE: { kind: 'SEND_FIRST_NOTICE', label: 'Send first notice' },
  SECOND_NOTICE: { kind: 'SEND_SECOND_NOTICE', label: 'Send second notice' },
  THIRD_NOTICE: { kind: 'SEND_THIRD_NOTICE', label: 'Send third notice' },
  FINAL_NOTICE: { kind: 'SEND_FINAL_NOTICE', label: 'Send final notice' },
};

/**
 * Priority score for an account. Dollars weighted by age and risk, boosted for a
 * broken promise. Age factor caps at 180 days so one ancient invoice can't
 * dominate the book forever; risk and broken-promise multipliers surface the
 * accounts a controller should touch first even at similar balances.
 */
export function computeAccountPriority(input: {
  overdueBalanceCents: number;
  maxDaysOverdue: number;
  riskLevel: RiskLevel;
  hasBrokenPromise: boolean;
}): number {
  const ageFactor = 1 + Math.min(Math.max(input.maxDaysOverdue, 0), 180) / 30;
  const risk = RISK_MULTIPLIER[input.riskLevel] ?? 1;
  const promiseBoost = input.hasBrokenPromise ? 1.5 : 1;
  return Math.round(input.overdueBalanceCents * ageFactor * risk * promiseBoost);
}

/**
 * Decide the next action for an account. Order of precedence:
 *   1. A pending promise (future date, still open) → wait, don't chase.
 *   2. A broken promise → call the customer; escalate if also high-risk/severe.
 *   3. Otherwise the cadence stage of the oldest overdue invoice drives the
 *      recommended notice; 90+ or high-risk final-stage → escalate.
 *   4. Nothing overdue enough for a stage → monitor.
 */
export function recommendAction(input: {
  maxDaysOverdue: number;
  riskLevel: RiskLevel;
  hasPendingPromise: boolean;
  pendingPromise: ClassifiedPromise | null;
  hasBrokenPromise: boolean;
  currentStage: DunningStage | null;
  reminderDue: boolean;
}): RecommendedAction {
  if (input.hasPendingPromise && input.pendingPromise) {
    return {
      kind: 'AWAIT_PROMISE',
      label: 'Awaiting promised payment',
      reason: `Customer committed to pay by ${input.pendingPromise.promiseDate}.`,
      stage: null,
    };
  }

  if (input.hasBrokenPromise) {
    const severe = input.riskLevel === 'high' || input.maxDaysOverdue >= 90;
    return severe
      ? { kind: 'ESCALATE', label: 'Escalate — broken promise', reason: 'A promise to pay was broken and the account is severe. Escalate.', stage: input.currentStage?.key ?? 'FINAL_NOTICE' }
      : { kind: 'CALL_BROKEN_PROMISE', label: 'Call — broken promise', reason: 'A promise to pay lapsed. Call before sending another notice.', stage: input.currentStage?.key ?? null };
  }

  if (input.currentStage) {
    if (input.currentStage.key === 'FINAL_NOTICE' && input.riskLevel === 'high') {
      return { kind: 'ESCALATE', label: 'Escalate to collections', reason: 'Final-notice stage on a high-risk account.', stage: 'FINAL_NOTICE' };
    }
    const map = STAGE_ACTION[input.currentStage.key];
    return {
      kind: map.kind,
      label: map.label,
      reason: input.reminderDue
        ? `${input.currentStage.label} is due (${input.maxDaysOverdue}d overdue).`
        : `${input.currentStage.label} sent recently; monitor for now.`,
      stage: input.currentStage.key,
    };
  }

  return { kind: 'MONITOR', label: 'Monitor', reason: 'Overdue but inside the first-notice grace window.', stage: null };
}

/**
 * Build the ranked worklist. Each account is aggregated, given a cadence stage
 * (from its oldest overdue invoice), a promise verdict, a recommended action,
 * and a priority score; the list is sorted worst-first.
 */
export function buildWorklist(accounts: WorklistAccountInput[], asOf: string): WorklistAccount[] {
  const out: WorklistAccount[] = accounts.map((acc) => {
    const overdueInvoices = acc.invoices.filter((i) => i.daysOverdue > 0 && i.balanceCents > 0);
    const maxDaysOverdue = overdueInvoices.reduce((m, i) => Math.max(m, i.daysOverdue), 0);

    // Focus invoice: the oldest overdue, tie-broken by largest balance.
    const focus = [...overdueInvoices].sort(
      (a, b) => b.daysOverdue - a.daysOverdue || b.balanceCents - a.balanceCents,
    )[0] ?? null;

    const currentStage = focus ? cadenceStageForDays(focus.daysOverdue) : null;
    const decision = focus
      ? decideReminder({
          daysOverdue: focus.daysOverdue,
          lastStageSent: focus.lastStageSent,
          lastReminderAt: focus.lastReminderAt,
          asOf,
        })
      : null;

    const pending = acc.promises.find((p) => p.status === 'PENDING') ?? null;
    const brokenCount = acc.promises.filter((p) => p.status === 'BROKEN').length;
    const hasBrokenPromise = brokenCount > 0;

    const recommendedAction = recommendAction({
      maxDaysOverdue,
      riskLevel: acc.riskLevel,
      hasPendingPromise: pending != null,
      pendingPromise: pending,
      hasBrokenPromise,
      currentStage,
      reminderDue: decision?.isDue ?? false,
    });

    const priorityScore = computeAccountPriority({
      overdueBalanceCents: acc.overdueBalanceCents,
      maxDaysOverdue,
      riskLevel: acc.riskLevel,
      hasBrokenPromise,
    });

    return {
      customerId: acc.customerId,
      customerName: acc.customerName,
      customerEmail: acc.customerEmail,
      riskLevel: acc.riskLevel,
      riskFlags: acc.riskFlags,
      riskSummary: acc.riskSummary,
      openBalanceCents: acc.openBalanceCents,
      overdueBalanceCents: acc.overdueBalanceCents,
      overdueInvoiceCount: overdueInvoices.length,
      maxDaysOverdue,
      focusInvoiceId: focus?.id ?? null,
      hasBrokenPromise,
      hasPendingPromise: pending != null,
      pendingPromise: pending,
      brokenPromiseCount: brokenCount,
      currentStage: currentStage?.key ?? null,
      reminderDue: decision?.isDue ?? false,
      recommendedAction,
      priorityScore,
      invoices: [...acc.invoices].sort((a, b) => b.balanceCents - a.balanceCents),
      promises: acc.promises,
    };
  });

  return out.sort((a, b) => b.priorityScore - a.priorityScore);
}
