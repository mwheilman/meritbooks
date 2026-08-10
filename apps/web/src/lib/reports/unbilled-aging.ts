/**
 * Unbilled-receivable (contract-asset, acct 1180) aging — PURE, deterministic.
 *
 * The owner's question: "does my unbilled receivable get added to the AR aging
 * report?" It should — as a DISTINCT unbilled line, aged to the month it was
 * accrued, WITHOUT commingling it into billed trade AR (that would break the
 * invoice-subledger tie-out and isn't GAAP-clean).
 *
 * This module takes the raw POSTED contributions to the 1180 account (each a
 * signed net = debit − credit, carrying the accrual's entry_date and — where the
 * JE recorded it — the job/customer it belongs to) and buckets them into the SAME
 * aging bands the billed AR report uses. Because the contract asset has no
 * "due date" (it isn't billed yet), aging is measured from the accrual month:
 * an underbilling accrued in the AS-OF month lands in CURRENT, one accrued a
 * month earlier in 1-30, and so on — "the month of the underbillings," exactly as
 * the owner framed it.
 *
 * TIE-OUT: the sum of every bucket equals the net 1180 GL balance the balance
 * sheet carries, so billed AR + unbilled AR reconciles to the ledger. All money
 * is integer cents. No I/O, no clock, no randomness — the sibling test file is
 * the correctness guarantee.
 */

/** The five aging bands, identical keys to the billed AR aging report. */
export const UNBILLED_BUCKET_ORDER = ['CURRENT', '1-30', '31-60', '61-90', '90+'] as const;
export type UnbilledBucketKey = (typeof UNBILLED_BUCKET_ORDER)[number];

/** One posted line touching the contract-asset account. */
export interface UnbilledContribution {
  /** Customer the job belongs to, if the JE was job-attributed. */
  customerName: string | null;
  /** Job id — the grouping key when present. */
  jobId: string | null;
  /** Human label for the job (number · name), if attributed. */
  jobLabel: string | null;
  /** Accrual entry_date, ISO 'YYYY-MM-DD'. */
  entryDate: string;
  /** Signed net for this line = debit_cents − credit_cents. */
  netCents: number;
}

/** A displayed group (one job, or the unattributed bucket) with its band split. */
export interface UnbilledAgingRow {
  /** Customer name, or 'Unattributed' when the accrual carried no job. */
  customerName: string;
  /** Job label, or null for the unattributed group. */
  jobLabel: string | null;
  buckets: Record<UnbilledBucketKey, number>;
  totalCents: number;
}

export interface UnbilledAgingResult {
  rows: UnbilledAgingRow[];
  buckets: Record<UnbilledBucketKey, number>;
  totalCents: number;
  /** True when at least one contribution carried a job/customer attribution. */
  hasAttribution: boolean;
}

function emptyBuckets(): Record<UnbilledBucketKey, number> {
  return { CURRENT: 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
}

/** Whole calendar months between the accrual month and the as-of month (>= 0). */
function monthsBetween(asOf: string, entryDate: string): number {
  const [ay, am] = asOf.split('-').map((n) => parseInt(n, 10));
  const [ey, em] = entryDate.split('-').map((n) => parseInt(n, 10));
  if (!ay || !am || !ey || !em) return 0;
  return ay * 12 + am - (ey * 12 + em);
}

/**
 * Which band an accrual falls in, measured by whole months from its entry_date to
 * the report as-of date. Same-month (or any future-dated) accrual → CURRENT.
 */
export function unbilledBucketFor(asOf: string, entryDate: string): UnbilledBucketKey {
  const m = monthsBetween(asOf, entryDate);
  if (m <= 0) return 'CURRENT';
  if (m === 1) return '1-30';
  if (m === 2) return '31-60';
  if (m === 3) return '61-90';
  return '90+';
}

/**
 * Build the aged unbilled-receivable model from posted 1180 contributions.
 *
 * Grouping: by job when the line carried one (customer + job label shown); every
 * unattributed line collapses into a single 'Unattributed' group so the total
 * still ties to the GL. A group whose net across all bands is zero (fully relieved
 * — billing has caught up) is dropped, so only live contract assets show.
 */
export function buildUnbilledAging(
  contributions: UnbilledContribution[],
  asOf: string,
): UnbilledAgingResult {
  const hasAttribution = contributions.some((c) => c.jobId != null);

  // Group key: the job id, or a single shared bucket for unattributed lines.
  const groups = new Map<
    string,
    { customerName: string; jobLabel: string | null; buckets: Record<UnbilledBucketKey, number> }
  >();

  for (const c of contributions) {
    const key = c.jobId ?? '__unattributed__';
    let g = groups.get(key);
    if (!g) {
      g = {
        customerName: c.jobId ? c.customerName ?? 'Unassigned customer' : 'Unattributed',
        jobLabel: c.jobId ? c.jobLabel : null,
        buckets: emptyBuckets(),
      };
      groups.set(key, g);
    }
    const band = unbilledBucketFor(asOf, c.entryDate);
    g.buckets[band] += c.netCents;
  }

  const rows: UnbilledAgingRow[] = [];
  const totals = emptyBuckets();
  let totalCents = 0;

  for (const g of groups.values()) {
    const rowTotal = UNBILLED_BUCKET_ORDER.reduce((s, b) => s + g.buckets[b], 0);
    if (rowTotal === 0) continue; // fully relieved — no live contract asset
    rows.push({ customerName: g.customerName, jobLabel: g.jobLabel, buckets: g.buckets, totalCents: rowTotal });
    for (const b of UNBILLED_BUCKET_ORDER) totals[b] += g.buckets[b];
    totalCents += rowTotal;
  }

  // Largest live balance first — most material contract assets on top.
  rows.sort((a, b) => b.totalCents - a.totalCents);

  return { rows, buckets: totals, totalCents, hasAttribution };
}
