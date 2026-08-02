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

import {
  cadenceStageForDays,
  decideReminder,
  nextCadenceStep,
  type DunningStage,
  type DunningStageKey,
  type NextCadenceStep,
} from './cadence';
import type { ClassifiedPromise } from './promises';
import {
  predictPayDate,
  computeExpectedValueAtRisk,
  type PayHistoryStats,
  type PayPrediction,
} from './prediction';

export type RiskLevel = 'low' | 'medium' | 'high';

/** One overdue open invoice feeding the worklist. */
export interface WorklistInvoiceInput {
  id: string;
  invoiceNumber: string;
  /** Invoice date, YYYY-MM-DD. Optional — required for a pay-date prediction. */
  invoiceDate?: string;
  dueDate: string; // YYYY-MM-DD
  balanceCents: number;
  daysOverdue: number;
  /** Most severe dunning stage already sent for this invoice, or null. */
  lastStageSent: DunningStageKey | null;
  lastReminderAt: string | null;
  reminderCount: number;
}

/** An invoice enriched with its pay-date prediction + next scheduled cadence step. */
export interface WorklistInvoice extends WorklistInvoiceInput {
  prediction: PayPrediction | null;
  nextStep: NextCadenceStep | null;
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
  /** Historical pay behavior for pay-date prediction (from the dossier). Optional. */
  payHistory?: PayHistoryStats;
  /** Net terms in days (for the terms-default prediction fallback). Default 30. */
  termsDays?: number;
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
  /** Overdue dollars weighted by predicted lateness — the ranking driver. */
  expectedValueAtRiskCents: number;
  /** Pay-date prediction for the focus (oldest overdue) invoice, if any. */
  focusPrediction: PayPrediction | null;
  /** The next scheduled cadence step for the focus invoice, if any. */
  nextStep: NextCadenceStep | null;
  invoices: WorklistInvoice[];
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
    const termsDays = acc.termsDays ?? 30;
    const history = acc.payHistory ?? null;

    // Enrich every invoice with a pay-date prediction + its next scheduled step.
    const predictInvoice = (inv: WorklistInvoiceInput): PayPrediction | null =>
      history && inv.invoiceDate
        ? predictPayDate({ invoiceDate: inv.invoiceDate, dueDate: inv.dueDate, asOf, termsDays, history })
        : null;

    const enrichedInvoices: WorklistInvoice[] = acc.invoices.map((inv) => ({
      ...inv,
      prediction: predictInvoice(inv),
      nextStep: nextCadenceStep({
        dueDate: inv.dueDate,
        daysOverdue: inv.daysOverdue,
        lastStageSent: inv.lastStageSent,
        lastReminderAt: inv.lastReminderAt,
        asOf,
      }),
    }));
    const byId = new Map(enrichedInvoices.map((i) => [i.id, i]));

    const overdueInvoices = enrichedInvoices.filter((i) => i.daysOverdue > 0 && i.balanceCents > 0);
    const maxDaysOverdue = overdueInvoices.reduce((m, i) => Math.max(m, i.daysOverdue), 0);

    // Focus invoice: the oldest overdue, tie-broken by largest balance.
    const focus = [...overdueInvoices].sort(
      (a, b) => b.daysOverdue - a.daysOverdue || b.balanceCents - a.balanceCents,
    )[0] ?? null;
    const focusEnriched = focus ? byId.get(focus.id) ?? null : null;
    const focusPrediction = focusEnriched?.prediction ?? null;
    const nextStep = focusEnriched?.nextStep ?? null;

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

    // Expected value-at-risk drives the ranking (balance × predicted lateness).
    const expectedValueAtRiskCents = computeExpectedValueAtRisk({
      overdueBalanceCents: acc.overdueBalanceCents,
      predictedDaysLate: focusPrediction?.predictedDaysLate ?? null,
      maxDaysOverdue,
    });

    // Priority folds predicted lateness into the age factor (falls back to current
    // aging when there's no prediction, preserving prior behavior).
    const effectiveLateness = Math.max(maxDaysOverdue, focusPrediction?.predictedDaysLate ?? 0);
    const priorityScore = computeAccountPriority({
      overdueBalanceCents: acc.overdueBalanceCents,
      maxDaysOverdue: effectiveLateness,
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
      expectedValueAtRiskCents,
      focusPrediction,
      nextStep,
      invoices: [...enrichedInvoices].sort((a, b) => b.balanceCents - a.balanceCents),
      promises: acc.promises,
    };
  });

  return out.sort((a, b) => b.priorityScore - a.priorityScore || b.expectedValueAtRiskCents - a.expectedValueAtRiskCents);
}
