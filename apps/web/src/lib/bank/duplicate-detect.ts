/**
 * Bank-feed duplicate detection (detect-only).
 *
 * A bank feed can surface the same economic event twice: a manual statement
 * import that overlaps a Plaid pull, a re-import of the same PDF, or a genuine
 * double bank posting. Approving both double-counts the GL, so we surface likely
 * duplicates for a human to review BEFORE they post. This module never mutates
 * or deletes anything — it only groups suspicious rows.
 *
 * A "likely duplicate" = two or more transactions with the SAME normalized
 * description AND the SAME absolute amount whose dates fall within a small window
 * of each other (default 3 days — covers weekend/settlement lag). Sign is folded
 * to absolute so a charge and its mirror aren't compared across in/out; grouping
 * on exact abs-cents keeps false positives low.
 *
 * Pure and deterministic (no Supabase, no Date.now) → unit-testable.
 */

export interface DupTxn {
  id: string;
  description: string;
  /** signed bigint cents; sign is folded to absolute for grouping. */
  amountCents: number;
  /** ISO date (YYYY-MM-DD). */
  date: string;
  /** transaction_status_enum — used only to tell the UI which rows are still open. */
  status?: string;
}

export interface DuplicateGroup {
  /** Stable key: `${normalizedDescription}|${absAmountCents}`. */
  key: string;
  normalizedDescription: string;
  /** Absolute amount shared by every member, in cents. */
  amountCents: number;
  /** A representative human-readable description (the first member's raw text). */
  sampleDescription: string;
  /** Member transaction ids, earliest date first. */
  transactionIds: string[];
  /** Distinct dates observed in the cluster (sorted). */
  dates: string[];
  count: number;
  /** True when at least one member is not yet posted (still actionable). */
  hasOpen: boolean;
}

/** Lowercase, strip punctuation to single spaces, collapse whitespace. */
export function normalizeDupDescription(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const POSTED_STATUSES = new Set(['POSTED', 'APPROVED']);

function daysBetween(a: string, b: string): number {
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (Number.isNaN(ta) || Number.isNaN(tb)) return Number.POSITIVE_INFINITY;
  return Math.abs(ta - tb) / 86_400_000;
}

/**
 * Group likely-duplicate bank transactions. Returns only clusters of 2+.
 *
 * Algorithm: bucket by (normalized description, abs amount); within each bucket
 * sort by date and single-link cluster rows within `windowDays` of the running
 * cluster's latest date. Any cluster with >= 2 members is reported.
 */
export function findDuplicateGroups(
  txns: DupTxn[],
  opts?: { windowDays?: number },
): DuplicateGroup[] {
  const windowDays = opts?.windowDays ?? 3;

  // Bucket by normalized description + absolute amount.
  const buckets = new Map<string, DupTxn[]>();
  for (const t of txns) {
    const norm = normalizeDupDescription(t.description);
    if (!norm) continue; // no textual signal — skip rather than over-match on amount alone
    const abs = Math.abs(t.amountCents);
    const key = `${norm}|${abs}`;
    const arr = buckets.get(key);
    if (arr) arr.push(t);
    else buckets.set(key, [t]);
  }

  const groups: DuplicateGroup[] = [];

  for (const [key, rows] of buckets) {
    if (rows.length < 2) continue;

    // Sort by date ascending, then id for stability.
    const sorted = [...rows].sort((a, b) => {
      const c = a.date.localeCompare(b.date);
      return c !== 0 ? c : a.id.localeCompare(b.id);
    });

    // Single-link clustering within the date window.
    let cluster: DupTxn[] = [];
    let clusterLatest = '';
    const flush = () => {
      if (cluster.length >= 2) {
        const first = cluster[0];
        const abs = Math.abs(first.amountCents);
        const [norm] = key.split('|');
        groups.push({
          key,
          normalizedDescription: norm,
          amountCents: abs,
          sampleDescription: first.description,
          transactionIds: cluster.map((c) => c.id),
          dates: [...new Set(cluster.map((c) => c.date))].sort(),
          count: cluster.length,
          hasOpen: cluster.some((c) => !POSTED_STATUSES.has((c.status ?? '').toUpperCase())),
        });
      }
      cluster = [];
      clusterLatest = '';
    };

    for (const row of sorted) {
      if (cluster.length === 0) {
        cluster = [row];
        clusterLatest = row.date;
        continue;
      }
      if (daysBetween(row.date, clusterLatest) <= windowDays) {
        cluster.push(row);
        if (row.date.localeCompare(clusterLatest) > 0) clusterLatest = row.date;
      } else {
        flush();
        cluster = [row];
        clusterLatest = row.date;
      }
    }
    flush();
  }

  // Most-duplicated / largest-amount first for a useful review order.
  groups.sort((a, b) => (b.count - a.count) || (b.amountCents - a.amountCents));
  return groups;
}

/** Flatten every transaction id that participates in a duplicate group. */
export function duplicateIdSet(groups: DuplicateGroup[]): Set<string> {
  const s = new Set<string>();
  for (const g of groups) for (const id of g.transactionIds) s.add(id);
  return s;
}
