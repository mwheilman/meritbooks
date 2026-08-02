/**
 * Fixed-asset roll-forward (continuity schedule) — PURE aggregation, no DB.
 *
 * The standard schedule auditors expect, per asset class and in total, for a
 * period [start, end]:
 *
 *   Cost:   Beginning + Additions − Disposals(cost)      = Ending cost
 *   Accum:  Beginning + Depreciation − Disposals(accum)  = Ending accumulated
 *   NBV:    Ending cost − Ending accumulated
 *
 * Cost movements come from the asset register (acquisition/disposal dates);
 * depreciation and the beginning/disposed accumulated balances are reconstructed
 * from the posted BOOK depreciation runs, so the schedule ties to the GL. The math
 * is pure and unit-tested; the route only fetches and calls it.
 */

export interface RollForwardAsset {
  id: string;
  category: string | null;
  acquisitionDate: string; // YYYY-MM-DD
  acquisitionCostCents: number;
  disposalDate: string | null; // YYYY-MM-DD
}

export interface RollForwardRun {
  fixedAssetId: string;
  periodYear: number;
  periodMonth: number; // 1..12
  amountCents: number;
}

export interface RollForwardRow {
  className: string;
  begCostCents: number;
  additionsCents: number;
  disposalsCostCents: number;
  endCostCents: number;
  begAccumCents: number;
  depreciationCents: number;
  disposalsAccumCents: number;
  endAccumCents: number;
  begNbvCents: number;
  endNbvCents: number;
}

export interface RollForwardResult {
  periodStart: string;
  periodEnd: string;
  classes: RollForwardRow[];
  total: RollForwardRow;
}

const UNCLASSIFIED = 'Unclassified';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** End-of-month date string for a posted run (runs post on the last day of month). */
function runDate(year: number, month: number): string {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${pad2(month)}-${pad2(last)}`;
}

function emptyRow(className: string): RollForwardRow {
  return {
    className,
    begCostCents: 0,
    additionsCents: 0,
    disposalsCostCents: 0,
    endCostCents: 0,
    begAccumCents: 0,
    depreciationCents: 0,
    disposalsAccumCents: 0,
    endAccumCents: 0,
    begNbvCents: 0,
    endNbvCents: 0,
  };
}

/**
 * Build the roll-forward for [periodStart, periodEnd] (inclusive YYYY-MM-DD).
 * Date comparisons are lexicographic on ISO dates (= chronological).
 */
export function computeRollForward(
  assets: RollForwardAsset[],
  runs: RollForwardRun[],
  periodStart: string,
  periodEnd: string
): RollForwardResult {
  if (periodEnd < periodStart) throw new Error('periodEnd must be on or after periodStart');

  const byId = new Map<string, RollForwardAsset>();
  for (const a of assets) byId.set(a.id, a);

  const rows = new Map<string, RollForwardRow>();
  const rowFor = (className: string): RollForwardRow => {
    let r = rows.get(className);
    if (!r) {
      r = emptyRow(className);
      rows.set(className, r);
    }
    return r;
  };

  // --- Cost movements from the register ---
  for (const a of assets) {
    const cls = a.category?.trim() || UNCLASSIFIED;
    const r = rowFor(cls);
    const onBooksAtStart = a.acquisitionDate < periodStart && (a.disposalDate === null || a.disposalDate >= periodStart);
    const acquiredInPeriod = a.acquisitionDate >= periodStart && a.acquisitionDate <= periodEnd;
    const disposedInPeriod = a.disposalDate !== null && a.disposalDate >= periodStart && a.disposalDate <= periodEnd;
    const onBooksAtEnd = a.acquisitionDate <= periodEnd && (a.disposalDate === null || a.disposalDate > periodEnd);

    if (onBooksAtStart) r.begCostCents += a.acquisitionCostCents;
    if (acquiredInPeriod) r.additionsCents += a.acquisitionCostCents;
    if (disposedInPeriod) r.disposalsCostCents += a.acquisitionCostCents;
    if (onBooksAtEnd) r.endCostCents += a.acquisitionCostCents;
  }

  // --- Accumulated-depreciation movements from posted runs ---
  for (const run of runs) {
    const a = byId.get(run.fixedAssetId);
    if (!a) continue;
    const cls = a.category?.trim() || UNCLASSIFIED;
    const r = rowFor(cls);
    const d = runDate(run.periodYear, run.periodMonth);

    const onBooksAtStart = a.acquisitionDate < periodStart && (a.disposalDate === null || a.disposalDate >= periodStart);
    const onBooksAtEnd = a.acquisitionDate <= periodEnd && (a.disposalDate === null || a.disposalDate > periodEnd);
    const disposedInPeriod = a.disposalDate !== null && a.disposalDate >= periodStart && a.disposalDate <= periodEnd;

    // Beginning accumulated: runs before the period, for assets on the books at start.
    if (onBooksAtStart && d < periodStart) r.begAccumCents += run.amountCents;
    // In-period depreciation expense.
    if (d >= periodStart && d <= periodEnd) r.depreciationCents += run.amountCents;
    // Accumulated removed on disposal: all of a disposed asset's runs up to disposal.
    if (disposedInPeriod && a.disposalDate !== null && d <= a.disposalDate) r.disposalsAccumCents += run.amountCents;
    // Ending accumulated: runs through period end, for assets on the books at end.
    if (onBooksAtEnd && d <= periodEnd) r.endAccumCents += run.amountCents;
  }

  const classes = [...rows.values()]
    .map((r) => ({ ...r, begNbvCents: r.begCostCents - r.begAccumCents, endNbvCents: r.endCostCents - r.endAccumCents }))
    .sort((a, b) => a.className.localeCompare(b.className));

  const total = emptyRow('TOTAL');
  for (const r of classes) {
    total.begCostCents += r.begCostCents;
    total.additionsCents += r.additionsCents;
    total.disposalsCostCents += r.disposalsCostCents;
    total.endCostCents += r.endCostCents;
    total.begAccumCents += r.begAccumCents;
    total.depreciationCents += r.depreciationCents;
    total.disposalsAccumCents += r.disposalsAccumCents;
    total.endAccumCents += r.endAccumCents;
  }
  total.begNbvCents = total.begCostCents - total.begAccumCents;
  total.endNbvCents = total.endCostCents - total.endAccumCents;

  return { periodStart, periodEnd, classes, total };
}
