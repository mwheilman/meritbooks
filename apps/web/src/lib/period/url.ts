/**
 * Period ⇄ URL query (PURE). One stable, shareable shape for every page:
 *
 *   ?period=2026-09                         → Sep 2026 (basis defaults to month)
 *   ?period=2026-09&basis=ttm               → TTM to Sep 2026
 *   ?period=2026-03&basis=range&from=2026-01 → Jan–Mar 2026
 *   ?period=2026-09&basis=ytd&compare=prior_year
 *
 * A URL period is ABSOLUTE (a link always shows the same months); the relative preset lives
 * only in the per-page memory (lib/period/memory.ts). An optional prefix lets one page host two
 * pickers (`?cmp_period=…`).
 */
import {
  isMonthKey,
  PERIOD_BASES,
  PERIOD_COMPARISONS,
  type PeriodBasis,
  type PeriodComparison,
  type PeriodSelection,
} from './resolve';

export interface QueryLike {
  get(name: string): string | null;
}

export function periodParamNames(prefix = ''): { period: string; basis: string; from: string; compare: string } {
  return { period: `${prefix}period`, basis: `${prefix}basis`, from: `${prefix}from`, compare: `${prefix}compare` };
}

function isBasis(v: unknown): v is PeriodBasis {
  return typeof v === 'string' && (PERIOD_BASES as readonly string[]).includes(v);
}

function isComparison(v: unknown): v is PeriodComparison {
  return typeof v === 'string' && (PERIOD_COMPARISONS as readonly string[]).includes(v);
}

/** Read a selection from the query, or null when the query carries no (valid) period. */
export function parsePeriodQuery(q: QueryLike, prefix = ''): PeriodSelection | null {
  const n = periodParamNames(prefix);
  const end = q.get(n.period);
  if (!isMonthKey(end)) return null;
  const basisRaw = q.get(n.basis);
  const basis: PeriodBasis = isBasis(basisRaw) ? basisRaw : 'month';
  const sel: PeriodSelection = { basis, end };
  if (basis === 'range') {
    const from = q.get(n.from);
    sel.start = isMonthKey(from) ? from : end;
  }
  const cmp = q.get(n.compare);
  if (isComparison(cmp)) sel.compare = cmp;
  return sel;
}

/** The query entries for a selection; null values mean "remove this key". */
export function periodQueryEntries(sel: PeriodSelection, prefix = ''): Record<string, string | null> {
  const n = periodParamNames(prefix);
  return {
    [n.period]: sel.end,
    [n.basis]: sel.basis === 'month' ? null : sel.basis,
    [n.from]: sel.basis === 'range' && sel.start ? sel.start : null,
    [n.compare]: sel.compare && sel.compare !== 'none' ? sel.compare : null,
  };
}

/** Merge a selection into an existing query string (keeps every unrelated key). */
export function withPeriodQuery(search: string, sel: PeriodSelection, prefix = ''): string {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  for (const [k, v] of Object.entries(periodQueryEntries(sel, prefix))) {
    if (v === null) params.delete(k);
    else params.set(k, v);
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

/** Same months + basis + comparison (preset is memory-only, so it is ignored). */
export function sameSelection(a: PeriodSelection | null, b: PeriodSelection | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.basis === b.basis &&
    a.end === b.end &&
    (a.basis !== 'range' || a.start === b.start) &&
    (a.compare ?? 'none') === (b.compare ?? 'none')
  );
}
