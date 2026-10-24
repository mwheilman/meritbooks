/**
 * Per-page "last period choice" memory.
 *
 * - A relative preset is remembered AS the preset ("ytd"), so next month "Year to date" still
 *   means year to date — never a stale frozen month.
 * - A concrete pick (a month in the grid, a custom range) is remembered as its months.
 *
 * Stored per browser in localStorage (`mb.period.<pageKey>`), and observed into the org's
 * learned-preference store (REPORT_PREFS · `period:<pageKey>`, lib/learning/preferences) so a
 * first visit on a new device can start on the team's usual choice. Learning only defaults a
 * selector — it never acts (canon §3).
 */
import { isMonthKey, isPresetId, PERIOD_BASES, PERIOD_COMPARISONS, type PeriodBasis, type PeriodComparison, type PeriodPresetId, type PeriodSelection } from './resolve';

export type RememberedPeriod =
  | { preset: Exclude<PeriodPresetId, 'custom'>; compare?: PeriodComparison }
  | { selection: PeriodSelection };

const PREFIX = 'mb.period.';

export function memoryKey(pageKey: string): string {
  return `${PREFIX}${pageKey}`;
}

export function preferenceKey(pageKey: string): string {
  return `period:${pageKey}`;
}

/** What to remember for a selection. */
export function toRemembered(sel: PeriodSelection): RememberedPeriod {
  if (sel.preset && sel.preset !== 'custom') {
    return sel.compare && sel.compare !== 'none' ? { preset: sel.preset, compare: sel.compare } : { preset: sel.preset };
  }
  const selection: PeriodSelection = { basis: sel.basis, end: sel.end };
  if (sel.basis === 'range' && sel.start) selection.start = sel.start;
  if (sel.compare && sel.compare !== 'none') selection.compare = sel.compare;
  return { selection };
}

function isBasis(v: unknown): v is PeriodBasis {
  return typeof v === 'string' && (PERIOD_BASES as readonly string[]).includes(v);
}

function isComparison(v: unknown): v is PeriodComparison {
  return typeof v === 'string' && (PERIOD_COMPARISONS as readonly string[]).includes(v);
}

/** Parse a stored value defensively (anything malformed → null). */
export function parseRemembered(raw: unknown): RememberedPeriod | null {
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (isPresetId(o.preset) && o.preset !== 'custom') {
    return isComparison(o.compare) ? { preset: o.preset, compare: o.compare } : { preset: o.preset };
  }
  const s = o.selection;
  if (s && typeof s === 'object') {
    const so = s as Record<string, unknown>;
    if (!isBasis(so.basis) || !isMonthKey(so.end)) return null;
    const sel: PeriodSelection = { basis: so.basis, end: so.end };
    if (so.basis === 'range') sel.start = isMonthKey(so.start) ? so.start : so.end;
    if (isComparison(so.compare)) sel.compare = so.compare;
    return { selection: sel };
  }
  return null;
}

/** The flat sample the learned-preference store tallies (it accepts flat scalar maps only). */
export function toPreferenceSample(r: RememberedPeriod): Record<string, string> {
  if ('preset' in r) return { preset: r.preset, compare: r.compare ?? 'none' };
  return {
    basis: r.selection.basis,
    end: r.selection.end,
    start: r.selection.start ?? '',
    compare: r.selection.compare ?? 'none',
  };
}

/** Inverse of toPreferenceSample (only presets are worth re-using across devices). */
export function fromPreferenceSample(v: unknown): RememberedPeriod | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (isPresetId(o.preset) && o.preset !== 'custom') {
    return isComparison(o.compare) && o.compare !== 'none' ? { preset: o.preset, compare: o.compare } : { preset: o.preset };
  }
  return null;
}

export function readRemembered(pageKey: string): RememberedPeriod | null {
  if (typeof window === 'undefined') return null;
  try {
    return parseRemembered(window.localStorage.getItem(memoryKey(pageKey)));
  } catch {
    return null;
  }
}

export function writeRemembered(pageKey: string, sel: PeriodSelection): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(memoryKey(pageKey), JSON.stringify(toRemembered(sel)));
  } catch {
    /* storage full / disabled — the URL still carries the choice */
  }
}
