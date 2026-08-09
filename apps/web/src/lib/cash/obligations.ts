/**
 * Near-term cash obligations — pure, deterministic bucketing.
 *
 * A treasurer looking at the cash balance needs to see what's committed against
 * it in the coming weeks: scheduled debt-service payments (from each loan's
 * amortization schedule) plus known recurring outflows (payroll / lease /
 * recurring bills). This module takes those already-resolved obligation items
 * and buckets them into standard horizons (7 / 30 / 60 / 90 days) so the UI can
 * show "cash after obligations" at a glance.
 *
 * No I/O. Money is bigint cents; every obligation `amountCents` is a POSITIVE
 * outflow magnitude.
 */

export type ObligationKind = 'DEBT' | 'RECURRING' | 'LEASE' | 'PAYROLL' | 'OTHER';

export interface ObligationItem {
  id: string;
  kind: ObligationKind;
  /** Human label (loan name, template name, …). */
  label: string;
  /** Counterparty (lender/vendor) when known. */
  party: string | null;
  /** yyyy-mm-dd the cash is due to move. */
  dueDate: string;
  /** Positive cents (outflow magnitude). */
  amountCents: number;
  /** Split, when known (debt payments): interest vs principal. */
  interestCents?: number;
  principalCents?: number;
}

export interface ObligationBucket {
  /** Horizon in days (7/30/60/90). */
  days: number;
  label: string;
  totalCents: number;
  count: number;
  /** currentCashCents − totalCents (can go negative → shortfall). */
  cashAfterCents: number;
}

export interface ObligationSummary {
  currentCashCents: number;
  asOfDate: string;
  items: ObligationItem[];
  buckets: ObligationBucket[];
  /** Everything within the widest horizon (90d). */
  totalWithinHorizonCents: number;
  /** First bucket (in day order) whose cashAfter goes negative; null if none. */
  firstShortfallDays: number | null;
}

const HORIZONS: Array<{ days: number; label: string }> = [
  { days: 7, label: 'Next 7 days' },
  { days: 30, label: 'Next 30 days' },
  { days: 60, label: 'Next 60 days' },
  { days: 90, label: 'Next 90 days' },
];

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface SummarizeParams {
  currentCashCents: number;
  items: ObligationItem[];
  today?: Date;
}

export function summarizeObligations(params: SummarizeParams): ObligationSummary {
  const today = params.today ? new Date(params.today) : new Date();
  const anchor = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const anchorMs = anchor.getTime();

  // Keep only positive outflows within the widest horizon; anything already past
  // due (dueDate < today) counts against the nearest bucket as "due now".
  const widest = HORIZONS[HORIZONS.length - 1].days;
  const horizonEndMs = anchorMs + widest * 86_400_000;

  const items = params.items
    .filter((i) => i.amountCents > 0)
    .filter((i) => {
      const t = new Date(i.dueDate.slice(0, 10) + 'T00:00:00Z').getTime();
      return t <= horizonEndMs;
    })
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  const buckets: ObligationBucket[] = HORIZONS.map(({ days, label }) => {
    const endMs = anchorMs + days * 86_400_000;
    let total = 0;
    let count = 0;
    for (const i of items) {
      const t = new Date(i.dueDate.slice(0, 10) + 'T00:00:00Z').getTime();
      if (t <= endMs) {
        total += i.amountCents;
        count += 1;
      }
    }
    return {
      days,
      label,
      totalCents: total,
      count,
      cashAfterCents: params.currentCashCents - total,
    };
  });

  const totalWithinHorizon = items.reduce((s, i) => s + i.amountCents, 0);
  const firstShort = buckets.find((b) => b.cashAfterCents < 0);

  return {
    currentCashCents: params.currentCashCents,
    asOfDate: isoDate(anchor),
    items,
    buckets,
    totalWithinHorizonCents: totalWithinHorizon,
    firstShortfallDays: firstShort ? firstShort.days : null,
  };
}
