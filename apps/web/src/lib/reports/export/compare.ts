/**
 * Comparative-period math — the SINGLE source of truth for deriving a comparison
 * window (prior period / prior year) from a selected range or as-of date, plus the
 * variance-% formatter. Both the on-screen report tables (report-viewer) and the
 * export builders import from here, so the comparative columns in the .xlsx / .csv
 * exports tie out EXACTLY to what the user sees on screen (FPB Dimension 7,
 * AC7.1/AC7.2) — the export re-projects the same figures, never re-derives a
 * different window.
 *
 * All functions are pure (no I/O, no floats-for-money) and operate on ISO date
 * strings (YYYY-MM-DD) using UTC so day counts never drift across DST.
 */

export type CompareMode = 'none' | 'prior_period' | 'prior_year' | 'budget';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function parseISO(s: string): { y: number; m: number; d: number } {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}
export function isoStr(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`;
}
export function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
export function addMonthsYM(y: number, m: number, delta: number): { y: number; m: number } {
  const idx = y * 12 + (m - 1) + delta;
  return { y: Math.floor(idx / 12), m: ((idx % 12) + 12) % 12 + 1 };
}
function shiftDaysISO(s: { y: number; m: number; d: number }, delta: number) {
  const t = new Date(Date.UTC(s.y, s.m - 1, s.d) + delta * 86400000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
function daysInclusive(a: { y: number; m: number; d: number }, b: { y: number; m: number; d: number }) {
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400000) + 1;
}

/**
 * Equal-length period ending immediately before the selected range. Whole-month
 * ranges shift by whole calendar months (a full year → the prior full year);
 * arbitrary ranges shift by exact day count.
 */
export function derivePriorPeriod(sd: string, ed: string): { s: string; e: string } {
  const a = parseISO(sd), b = parseISO(ed);
  const wholeMonths = a.d === 1 && b.d === lastDayOfMonth(b.y, b.m);
  if (wholeMonths) {
    const span = (b.y * 12 + b.m) - (a.y * 12 + a.m) + 1;
    const ps = addMonthsYM(a.y, a.m, -span);
    const pe = addMonthsYM(a.y, a.m, -1);
    return { s: isoStr(ps.y, ps.m, 1), e: isoStr(pe.y, pe.m, lastDayOfMonth(pe.y, pe.m)) };
  }
  const len = daysInclusive(a, b);
  const pe = shiftDaysISO(a, -1);
  const ps = shiftDaysISO(pe, -(len - 1));
  return { s: isoStr(ps.y, ps.m, ps.d), e: isoStr(pe.y, pe.m, pe.d) };
}

/** The same calendar range exactly one year earlier (month-end aware). */
export function derivePriorYear(sd: string, ed: string): { s: string; e: string } {
  const a = parseISO(sd), b = parseISO(ed);
  const sD = Math.min(a.d, lastDayOfMonth(a.y - 1, a.m));
  const eD = b.d === lastDayOfMonth(b.y, b.m) ? lastDayOfMonth(b.y - 1, b.m) : Math.min(b.d, lastDayOfMonth(b.y - 1, b.m));
  return { s: isoStr(a.y - 1, a.m, sD), e: isoStr(b.y - 1, b.m, eD) };
}

/**
 * A Balance Sheet is a point in time, so its comparison is a prior AS-OF date:
 * prior_period = prior month-end; prior_year = the same date one year earlier
 * (month-end aware). Returns null for modes without a meaningful BS comparison.
 */
export function derivePriorAsOf(ed: string, mode: CompareMode): string | null {
  if (!ed) return null;
  const b = parseISO(ed);
  if (mode === 'prior_year') {
    return isoStr(b.y - 1, b.m, b.d === lastDayOfMonth(b.y, b.m) ? lastDayOfMonth(b.y - 1, b.m) : b.d);
  }
  if (mode === 'prior_period') {
    const pm = addMonthsYM(b.y, b.m, -1);
    return isoStr(pm.y, pm.m, lastDayOfMonth(pm.y, pm.m));
  }
  return null;
}

/** Short header label for the comparison column (matches the on-screen tables). */
export function compareLabel(mode: CompareMode): string {
  return mode === 'prior_year' ? 'Prior Yr' : mode === 'prior_period' ? 'Prior Period' : mode === 'budget' ? 'Budget' : '';
}

/**
 * Variance as a signed percentage of the comparison base, e.g. "+12.3%".
 * Returns "—" when the base is zero (percent undefined) — identical to the
 * on-screen formatter so exported cells match the table.
 */
export function variancePct(variance: number, base: number): string {
  return base !== 0 ? `${variance > 0 ? '+' : ''}${Math.round((variance / Math.abs(base)) * 1000) / 10}%` : '—';
}
