/**
 * The dunning LADDER decision for one invoice — PURE (no I/O, no clock), so every stop
 * condition is unit-tested. The scheduled `ar.dunning` job feeds it the facts and carries
 * out the answer through the request engine (lib/requests): that is where quiet hours,
 * unsubscribe / suppression, bounce handling and send quotas apply.
 *
 *   stop (cancel any live reminder):  invoice settled · customer excluded · disputed
 *                                     (stop_on_dispute) · promise-to-pay pending
 *                                     (stop_on_promise) · balance under the minimum ·
 *                                     ladder switched off
 *   nothing to do:                    no email on file · not old enough for any step ·
 *                                     that step (or a later one) already went out ·
 *                                     the step is already waiting in Requests
 *   create:                           the highest step the invoice has reached, when it is
 *                                     past every step already sent (a stale live reminder
 *                                     for an earlier step is cancelled — "superseded")
 *
 * One reminder per step, ever: a step counts as done once it was SENT (by the ladder or by
 * hand from Collections) or a PERSON cancelled it. The ladder never re-sends a step and
 * never jumps back down.
 */

import { STAGE_LABEL, type DunningPolicy, type DunningStep, type DunningStepStage } from './dunning-policy';

export interface LiveDunningRequest {
  id: string;
  stage: DunningStepStage;
  /** Already went out at least once (sends_count > 0). */
  sent: boolean;
}

export interface DunningInvoiceFacts {
  invoiceId: string;
  customerId: string | null;
  balanceCents: number;
  status: string;
  /** Whole days past the due date at asOf (negative = not yet due). */
  daysPastDue: number;
  disputed: boolean;
  hasEmail: boolean;
  promisePending: boolean;
  /** Steps already done for this invoice (sent, or cancelled by a person). */
  doneStages: ReadonlySet<DunningStepStage>;
  live: LiveDunningRequest | null;
}

export type DunningDecision =
  | { action: 'none'; reason: NoneReason }
  | { action: 'stop'; reason: StopReason; cancelId: string | null }
  | { action: 'create'; step: DunningStep; stepIndex: number; nextStep: DunningStep | null; supersedeId: string | null };

export type NoneReason = 'no_email' | 'not_due' | 'already_sent' | 'already_waiting';
export type StopReason = 'settled' | 'excluded' | 'disputed' | 'promise' | 'below_minimum' | 'disabled';

export const STOP_REASON_TEXT: Record<StopReason, string> = {
  settled: 'The invoice is paid or closed.',
  excluded: 'This customer is excluded from payment reminders.',
  disputed: 'The invoice is disputed — reminders are on hold.',
  promise: 'The customer promised to pay — reminders are on hold until the promise date passes.',
  below_minimum: 'The balance is under the reminder minimum.',
  disabled: 'Payment reminders are switched off.',
};

const CLOSED = new Set(['PAID', 'VOIDED', 'WRITTEN_OFF', 'CREDITED', 'DRAFT']);

/** Steps sorted by days (the ladder order). */
export function orderedSteps(policy: DunningPolicy): DunningStep[] {
  return [...policy.steps].sort((a, b) => a.days - b.days);
}

export function decideDunning(f: DunningInvoiceFacts, policy: DunningPolicy, customerExcluded: boolean): DunningDecision {
  const stop = (reason: StopReason): DunningDecision =>
    f.live ? { action: 'stop', reason, cancelId: f.live.id } : { action: 'none', reason: 'not_due' };

  if (f.balanceCents <= 0 || CLOSED.has(f.status)) return stop('settled');
  if (!policy.enabled) return f.live && !f.live.sent ? stop('disabled') : { action: 'none', reason: 'not_due' };
  if (customerExcluded) return stop('excluded');
  if (f.disputed && policy.stopOnDispute) return stop('disputed');
  if (f.promisePending && policy.stopOnPromise) return stop('promise');
  if (f.balanceCents < policy.minBalanceCents) return stop('below_minimum');

  const steps = orderedSteps(policy);
  let idx = -1;
  for (let i = 0; i < steps.length; i++) if (f.daysPastDue >= steps[i].days) idx = i;
  if (idx < 0) return { action: 'none', reason: 'not_due' };

  // Never go back down the ladder or repeat a step.
  const stageRank = (s: DunningStepStage) => steps.findIndex((x) => x.stage === s);
  let highestDone = -1;
  for (const s of f.doneStages) highestDone = Math.max(highestDone, stageRank(s));
  if (f.live?.sent) highestDone = Math.max(highestDone, stageRank(f.live.stage));
  if (idx <= highestDone) return { action: 'none', reason: 'already_sent' };

  const step = steps[idx];
  if (f.live && f.live.stage === step.stage) return { action: 'none', reason: 'already_waiting' };
  if (!f.hasEmail) return { action: 'none', reason: 'no_email' };
  return {
    action: 'create',
    step,
    stepIndex: idx,
    nextStep: steps[idx + 1] ?? null,
    supersedeId: f.live ? f.live.id : null,
  };
}

/** Minutes to keep a reminder open after it goes out: until the next step is due (≥ 1 day), else 14 days. */
export function holdMinutes(step: DunningStep, next: DunningStep | null): number {
  const days = next ? Math.max(1, next.days - step.days) + 1 : 14;
  return Math.min(525_600, Math.max(15, days * 1440));
}

export function supersedeReason(step: DunningStep): string {
  return `Superseded by the ${STAGE_LABEL[step.stage].toLowerCase()}.`;
}

/** Whole days from due date to asOf (both YYYY-MM-DD). */
export function daysPastDue(dueDate: string, asOf: string): number {
  const a = Date.parse(`${dueDate.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${asOf.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.floor((b - a) / 86_400_000);
}
