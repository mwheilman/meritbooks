/**
 * Derived work queues for the floor-plan screen. Pure.
 *
 *  - payoffsToPropose: sold-unpaid notes with no open (PROPOSED) payoff yet.
 *  - sortSotFindings: CRITICAL first, then most days past due, then largest principal.
 *  - describeEvidence: SOT evidence in plain English.
 *  - curtailmentUrgency: DL-2 highlight for a curtailment row.
 */

import type { SotFinding } from '@/lib/dealer/engine/sot';
import { SOLD_DETECTED_BY } from '@/lib/dealer/ui/labels';
import { dateLabel, daysBetween } from '@/lib/dealer/ui/format';
import type { CurtailmentStatus } from '@/lib/dealer/types';
import type { FpNote, FpTxn } from './types';

export function payoffsToPropose(soldUnpaid: FpNote[], proposedPayoffs: Pick<FpTxn, 'note_id' | 'status'>[]): FpNote[] {
  const open = new Set(proposedPayoffs.filter((t) => t.status === 'PROPOSED' && t.note_id).map((t) => t.note_id as string));
  return soldUnpaid
    .filter((n) => n.status === 'SOLD_UNPAID' && n.principal_balance_cents > 0 && !open.has(n.id))
    .sort((a, b) => (a.payoff_due_date ?? '9999').localeCompare(b.payoff_due_date ?? '9999'));
}

export function sortSotFindings(f: SotFinding[]): SotFinding[] {
  return [...f].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'CRITICAL' ? -1 : 1;
    if (a.daysPastDue !== b.daysPastDue) return b.daysPastDue - a.daysPastDue;
    return b.principalCents - a.principalCents;
  });
}

export function describeEvidence(e: SotFinding['evidence'][number]): string {
  const what = SOLD_DETECTED_BY[e.source] ?? e.source;
  const ref = e.ref ? (e.source === 'LENDER_AUDIT' ? ` (lender code ${e.ref})` : e.source === 'DMS_DEAL' ? ` (deal ${e.ref})` : ` (${e.ref})`) : '';
  return `${what}${ref} · ${dateLabel(e.date)}`;
}

export type Urgency = 'missed' | 'overdue' | 'soon' | 'later' | 'settled';

/** DL-2: missed / past due → red; due within `warnDays` → amber. */
export function curtailmentUrgency(c: { status: CurtailmentStatus; due_date: string }, today: string, warnDays: number): Urgency {
  if (c.status === 'PAID' || c.status === 'WAIVED') return 'settled';
  if (c.status === 'MISSED') return 'missed';
  const d = daysBetween(today, c.due_date) ?? 0;
  if (d < 0) return 'overdue';
  if (d <= warnDays) return 'soon';
  return 'later';
}

/** Utilization tone for a line bar (DL-10). */
export function utilizationTone(bps: number | null, warnBps: number, status: string): 'danger' | 'warning' | 'ok' {
  if (status === 'CREDIT_HOLD') return 'danger';
  if (bps === null) return 'ok';
  if (bps > 10_000) return 'danger';
  if (bps >= warnBps) return 'warning';
  return 'ok';
}
