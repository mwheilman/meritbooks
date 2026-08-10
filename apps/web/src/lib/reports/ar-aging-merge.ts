/**
 * AR Aging merge — PURE, deterministic. No I/O, no clock, no randomness.
 *
 * The owner's intent: ONE unified "AR Aging" report. The parent reads as a single
 * AR number per customer — billed trade AR + unbilled receivable (contract asset,
 * acct 1180) COMBINED per aging bucket. A user can EXPAND a customer to see the
 * split into a Billed child and an Unbilled child (each with its own bucket
 * amounts), and can drill the Billed child to invoices or the Unbilled child to
 * jobs.
 *
 * This module takes the two sides the ar-aging route already computes — billed
 * per-invoice lines (from the v_ar_aging invoice view) and the unbilled
 * per-customer/job rows (from the GL 1180 account) — and merges them BY CUSTOMER
 * without recomputing either side's amounts. The billed numbers are the same
 * cents the invoice subledger carries; the unbilled numbers are the same cents the
 * GL carries. The grand combined total therefore ties to (billed subtotal +
 * unbilled subtotal) exactly. All money is integer cents.
 *
 * The sibling test file is the correctness guarantee.
 */

/** The five aging bands, in display order — identical keys to both source sides. */
export const AR_BUCKET_ORDER = ['CURRENT', '1-30', '31-60', '61-90', '90+'] as const;
export type ArBucketKey = (typeof AR_BUCKET_ORDER)[number];

const BUCKET_SET = new Set<string>(AR_BUCKET_ORDER);

/** One posted invoice's open balance, already aged into a single band. */
export interface BilledInvoiceLine {
  customerName: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  /** One of AR_BUCKET_ORDER. Unknown bands are ignored (defensive). */
  agingBucket: string;
  balanceCents: number;
  locationName: string;
}

/** One unbilled contract-asset group (a job, or the unattributed bucket). */
export interface UnbilledJobRow {
  customerName: string;
  jobLabel: string | null;
  buckets: Record<string, number>;
  totalCents: number;
}

function emptyBuckets(): Record<ArBucketKey, number> {
  return { CURRENT: 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
}

/** A customer's billed sub-total, its band split, and the invoices behind it. */
export interface BilledChild {
  buckets: Record<ArBucketKey, number>;
  totalCents: number;
  lines: BilledInvoiceLine[];
}

/** A customer's unbilled sub-total, its band split, and the jobs behind it. */
export interface UnbilledChild {
  buckets: Record<ArBucketKey, number>;
  totalCents: number;
  jobs: UnbilledJobRow[];
}

/** One combined customer row: COMBINED buckets/total + the two children. */
export interface MergedCustomer {
  customerName: string;
  /** billed + unbilled per band. */
  buckets: Record<ArBucketKey, number>;
  /** billed + unbilled combined. */
  totalCents: number;
  billed: BilledChild;
  unbilled: UnbilledChild;
  hasBilled: boolean;
  hasUnbilled: boolean;
}

export interface MergedArAging {
  /** Combined customers, most material (largest combined total) first. */
  customers: MergedCustomer[];
  billedTotals: Record<ArBucketKey, number>;
  billedTotalCents: number;
  unbilledTotals: Record<ArBucketKey, number>;
  unbilledTotalCents: number;
  combinedTotals: Record<ArBucketKey, number>;
  combinedTotalCents: number;
}

interface Accum {
  customerName: string;
  billed: BilledChild;
  unbilled: UnbilledChild;
}

/**
 * Merge billed invoice lines + unbilled job rows into one combined-by-customer
 * model. Customers are keyed by name (the only join key both sides share). A
 * customer present on only one side renders correctly — the missing side is all
 * zeros. Buckets missing on one side are treated as 0. Rows sort by combined
 * total descending so the most material customer is on top.
 */
export function mergeArAging(
  billedLines: BilledInvoiceLine[],
  unbilledRows: UnbilledJobRow[],
): MergedArAging {
  const byCustomer = new Map<string, Accum>();

  const ensure = (name: string): Accum => {
    let a = byCustomer.get(name);
    if (!a) {
      a = {
        customerName: name,
        billed: { buckets: emptyBuckets(), totalCents: 0, lines: [] },
        unbilled: { buckets: emptyBuckets(), totalCents: 0, jobs: [] },
      };
      byCustomer.set(name, a);
    }
    return a;
  };

  for (const line of billedLines) {
    const a = ensure(line.customerName);
    a.billed.lines.push(line);
    if (BUCKET_SET.has(line.agingBucket)) {
      a.billed.buckets[line.agingBucket as ArBucketKey] += line.balanceCents;
    }
    a.billed.totalCents += line.balanceCents;
  }

  for (const row of unbilledRows) {
    const a = ensure(row.customerName);
    a.unbilled.jobs.push(row);
    for (const b of AR_BUCKET_ORDER) {
      a.unbilled.buckets[b] += row.buckets[b] ?? 0;
    }
    a.unbilled.totalCents += row.totalCents;
  }

  const billedTotals = emptyBuckets();
  const unbilledTotals = emptyBuckets();
  const combinedTotals = emptyBuckets();
  let billedTotalCents = 0;
  let unbilledTotalCents = 0;

  const customers: MergedCustomer[] = [];
  for (const a of byCustomer.values()) {
    const buckets = emptyBuckets();
    for (const b of AR_BUCKET_ORDER) {
      buckets[b] = a.billed.buckets[b] + a.unbilled.buckets[b];
      billedTotals[b] += a.billed.buckets[b];
      unbilledTotals[b] += a.unbilled.buckets[b];
      combinedTotals[b] += buckets[b];
    }
    const totalCents = a.billed.totalCents + a.unbilled.totalCents;
    billedTotalCents += a.billed.totalCents;
    unbilledTotalCents += a.unbilled.totalCents;
    customers.push({
      customerName: a.customerName,
      buckets,
      totalCents,
      billed: a.billed,
      unbilled: a.unbilled,
      hasBilled: a.billed.lines.length > 0 || a.billed.totalCents !== 0,
      hasUnbilled: a.unbilled.jobs.length > 0 || a.unbilled.totalCents !== 0,
    });
  }

  // Most material combined balance first; stable tie-break by name so the order
  // is deterministic for tests and for the user.
  customers.sort((x, y) => y.totalCents - x.totalCents || x.customerName.localeCompare(y.customerName));

  return {
    customers,
    billedTotals,
    billedTotalCents,
    unbilledTotals,
    unbilledTotalCents,
    combinedTotals,
    combinedTotalCents: billedTotalCents + unbilledTotalCents,
  };
}
