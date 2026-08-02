/**
 * Promise-to-pay tracking — pure classification.
 *
 * A "promise to pay" is a human-logged commitment: a customer said they'll pay
 * $X by date D (optionally against a specific invoice). We persist promises to
 * the immutable audit rail (core.action_log) — NO new table (this wave reuses
 * existing storage). The route reads them back; THIS module decides, purely and
 * testably, whether each promise is still pending, was kept, or is broken.
 *
 * A broken promise is the strongest collection signal short of a write-off, so
 * the worklist boosts any account carrying one — see worklist.ts.
 */

/** The action_log verb a logged promise is stored under. */
export const PROMISE_ACTION = 'collections.promise.logged';

export type PromiseStatus = 'PENDING' | 'KEPT' | 'BROKEN';

/** A promise as read back from the audit rail. */
export interface PromiseToPay {
  id: string;
  customerId: string;
  /** Optional specific invoice the promise is against. */
  invoiceId: string | null;
  amountCents: number;
  /** ISO date (YYYY-MM-DD) the customer committed to pay by. */
  promiseDate: string;
  note: string | null;
  createdAt: string; // ISO timestamp
}

/**
 * The current settlement facts for the target of a promise, at `asOf`. For an
 * invoice-scoped promise this is that invoice's live balance/status; for a
 * customer-scoped promise it's the customer's current overdue balance.
 */
export interface PromiseSettlementState {
  /** Amount paid toward the target SINCE the promise was made (cents). */
  paidSinceCents: number;
  /** Current open balance still owed on the target (cents). */
  openBalanceCents: number;
  /** True when the target invoice is fully settled (PAID / zero balance). */
  settled: boolean;
}

/** Whole days from `from` to `to` (YYYY-MM-DD/ISO). 0 on bad input. */
function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso.length <= 10 ? `${fromIso}T00:00:00Z` : fromIso);
  const b = Date.parse(toIso.length <= 10 ? `${toIso}T00:00:00Z` : toIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.floor((b - a) / 86_400_000);
}

/**
 * Classify a single promise as of `asOf`. Pure.
 *
 * KEPT    — the target is settled, or the promised amount has been paid since.
 * BROKEN  — the promise date has passed and money is still owed.
 * PENDING — the promise date is in the future and the target is still open.
 *
 * A small grace (`graceDays`, default 0) can absorb settlement lag on the exact
 * due date; the default treats the promised date as a hard line.
 */
export function classifyPromise(
  promise: Pick<PromiseToPay, 'amountCents' | 'promiseDate'>,
  state: PromiseSettlementState,
  asOf: string,
  graceDays = 0,
): PromiseStatus {
  // Kept if the target cleared or the promised amount (or more) was paid since.
  if (state.settled || (promise.amountCents > 0 && state.paidSinceCents >= promise.amountCents)) {
    return 'KEPT';
  }
  // Nothing left owed and nothing promised-but-unmet → treat as kept.
  if (state.openBalanceCents <= 0) return 'KEPT';

  const daysPastPromise = daysBetween(promise.promiseDate, asOf);
  if (daysPastPromise > graceDays) return 'BROKEN';
  return 'PENDING';
}

export interface ClassifiedPromise extends PromiseToPay {
  status: PromiseStatus;
  /** Days past the promise date at `asOf` (negative = still in the future). */
  daysPastPromise: number;
}

/**
 * Classify a batch of promises. `stateFor` resolves the settlement facts for a
 * promise's target (kept out of this module so the math stays pure). Returns the
 * newest-first list with a status on each. Only the LATEST promise per target is
 * authoritative — an earlier broken promise superseded by a newer commitment is
 * marked SUPERSEDED-by-omission (dropped from the broken set) via `latestOnly`.
 */
export function classifyPromises(
  promises: PromiseToPay[],
  stateFor: (p: PromiseToPay) => PromiseSettlementState,
  asOf: string,
  opts: { latestOnly?: boolean; graceDays?: number } = {},
): ClassifiedPromise[] {
  const sorted = [...promises].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const seenTargets = new Set<string>();
  const out: ClassifiedPromise[] = [];
  for (const p of sorted) {
    const targetKey = p.invoiceId ?? `cust:${p.customerId}`;
    if (opts.latestOnly && seenTargets.has(targetKey)) continue;
    seenTargets.add(targetKey);
    out.push({
      ...p,
      status: classifyPromise(p, stateFor(p), asOf, opts.graceDays ?? 0),
      daysPastPromise: daysBetween(p.promiseDate, asOf),
    });
  }
  return out;
}

/** The broken subset of a classified list. */
export function brokenPromises(classified: ClassifiedPromise[]): ClassifiedPromise[] {
  return classified.filter((p) => p.status === 'BROKEN');
}
