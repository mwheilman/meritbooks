/**
 * The 13-week direct cash forecast engine (FP-11, AC-CF4 / AC-CF6) — pure, integer cents.
 *
 * Week 1 starts on the Monday of the current week; the opening balance is cash as of TODAY, so
 * week 1 holds today → Sunday (days before today are history, not forecast). Every item is dated
 * on or after today by its source builder. For each scope (each company, and the combined group):
 *
 *   opening(w1) = opening balance;  closing(w) = opening(w) + inflows(w) − outflows(w);
 *   opening(w+1) = closing(w);      the daily series ties to the weekly one.
 *
 * Combined = Σ companies' openings + every item EXCEPT intercompany items (counterparty is another
 * company in scope), which net to zero for the group; org-level items (companyId null — e.g. sales
 * tax filed at the org) appear in the combined view only.
 *
 * Confidence band (80%): ± z·√(Σ item variance through the week) + MAPE × Σ|weekly net| through the
 * week, where a receipt with probability p has variance p(1−p)·gross², an ESTIMATED item a 10%
 * coefficient of variation (5% payroll), COMMITTED / known items none.
 */

import { addDays, mondayOf } from './dates';
import { CATEGORY_LABEL, type Category, type ForecastItem } from './types';

export const HORIZON_WEEKS = 13;
export const BAND_Z = 1.2816; // 80% two-sided
export const ENGINE_VERSION = 'cash-forecast/1';

export interface CompanyOpening {
  id: string;
  name: string;
  openingCents: number;
  minimumCents: number;
}

export interface EngineInput {
  today: string;
  companies: readonly CompanyOpening[];
  items: readonly ForecastItem[];
  horizonWeeks?: number;
  /** Trailing forecast error (0..1) — widens the band when known. */
  mape?: number | null;
}

export interface ForecastWeek {
  index: number;
  weekNumber: number;
  start: string;
  end: string;
  openingCents: number;
  inflowsCents: number;
  outflowsCents: number;
  netCents: number;
  closingCents: number;
  byCategory: Partial<Record<Category, number>>;
  loCents: number;
  hiCents: number;
  belowMinimum: boolean;
  itemCount: number;
}

export interface ForecastDay {
  date: string;
  openingCents: number;
  inflowsCents: number;
  outflowsCents: number;
  closingCents: number;
  itemCount: number;
}

export interface ScopeForecast {
  scopeId: string;
  name: string;
  openingCents: number;
  minimumCents: number;
  weeks: ForecastWeek[];
  days: ForecastDay[];
  closingCents: number;
  totals: { inflowsCents: number; outflowsCents: number; netCents: number };
  byCategory: Partial<Record<Category, number>>;
  lowPoint: { cents: number; date: string; weekIndex: number };
  firstBreach: { weekIndex: number; date: string; shortfallCents: number } | null;
  /** Largest (minimum − closing) over the horizon, 0 when never below minimum. */
  maxShortfallCents: number;
  negativeWeekCount: number;
  zeroCashDate: string | null;
  itemCount: number;
}

export interface CashForecast {
  today: string;
  anchorDate: string;
  horizonEnd: string;
  horizonWeeks: number;
  engineVersion: string;
  combined: ScopeForecast;
  companies: ScopeForecast[];
  items: ForecastItem[];
  /** Keys of items left out of the combined view (intercompany). */
  combinedExcludedKeys: string[];
  intercompanyExcluded: { count: number; inflowsCents: number; outflowsCents: number };
  beyondHorizon: { inflowsCents: number; outflowsCents: number; count: number };
}

const PAYROLL_CATS: ReadonlySet<Category> = new Set<Category>(['PAYROLL', 'PAYROLL_TAX']);

export function itemVariance(it: ForecastItem): number {
  if (it.certainty === 'COMMITTED') return 0;
  if (it.direction === 'IN' && it.probability > 0 && it.probability < 1) {
    return it.probability * (1 - it.probability) * it.grossCents * it.grossCents;
  }
  if (it.certainty === 'ESTIMATED') {
    const cv = PAYROLL_CATS.has(it.category) ? 0.05 : 0.1;
    return (cv * it.amountCents) ** 2;
  }
  return 0;
}

export function horizonEndOf(today: string, weeks = HORIZON_WEEKS): string {
  return addDays(mondayOf(today), weeks * 7 - 1);
}

function emptyWeeks(anchor: string, n: number): ForecastWeek[] {
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    weekNumber: i + 1,
    start: addDays(anchor, i * 7),
    end: addDays(anchor, i * 7 + 6),
    openingCents: 0,
    inflowsCents: 0,
    outflowsCents: 0,
    netCents: 0,
    closingCents: 0,
    byCategory: {},
    loCents: 0,
    hiCents: 0,
    belowMinimum: false,
    itemCount: 0,
  }));
}

function buildScope(
  scopeId: string,
  name: string,
  openingCents: number,
  minimumCents: number,
  items: readonly ForecastItem[],
  today: string,
  anchor: string,
  horizonEnd: string,
  weeksN: number,
  mape: number,
): ScopeForecast {
  const weeks = emptyWeeks(anchor, weeksN);
  const dayCount = Math.max(0, Math.round((Date.parse(horizonEnd) - Date.parse(today)) / 86_400_000) + 1);
  const days: ForecastDay[] = Array.from({ length: dayCount }, (_, i) => ({
    date: addDays(today, i),
    openingCents: 0,
    inflowsCents: 0,
    outflowsCents: 0,
    closingCents: 0,
    itemCount: 0,
  }));
  const dayIndex = new Map(days.map((d, i) => [d.date, i]));
  const variance = new Array<number>(weeksN).fill(0);
  const byCategory: Partial<Record<Category, number>> = {};
  let count = 0;

  for (const it of items) {
    if (it.date < today || it.date > horizonEnd || !(it.amountCents > 0)) continue;
    const wi = Math.floor((Date.parse(it.date) - Date.parse(anchor)) / (7 * 86_400_000));
    if (wi < 0 || wi >= weeksN) continue;
    const w = weeks[wi];
    if (it.direction === 'IN') w.inflowsCents += it.amountCents;
    else w.outflowsCents += it.amountCents;
    w.byCategory[it.category] = (w.byCategory[it.category] ?? 0) + it.amountCents;
    byCategory[it.category] = (byCategory[it.category] ?? 0) + it.amountCents;
    w.itemCount += 1;
    variance[wi] += itemVariance(it);
    const di = dayIndex.get(it.date);
    if (di !== undefined) {
      if (it.direction === 'IN') days[di].inflowsCents += it.amountCents;
      else days[di].outflowsCents += it.amountCents;
      days[di].itemCount += 1;
    }
    count += 1;
  }

  let bal = openingCents;
  let cumVar = 0;
  let cumAbsNet = 0;
  let low = { cents: openingCents, date: today, weekIndex: -1 };
  let firstBreach: ScopeForecast['firstBreach'] = null;
  let maxShort = minimumCents > 0 && openingCents < minimumCents ? minimumCents - openingCents : 0;
  let neg = 0;
  for (const w of weeks) {
    w.openingCents = bal;
    w.netCents = w.inflowsCents - w.outflowsCents;
    w.closingCents = bal + w.netCents;
    bal = w.closingCents;
    cumVar += variance[w.index];
    cumAbsNet += Math.abs(w.netCents);
    const half = Math.round(BAND_Z * Math.sqrt(cumVar) + mape * cumAbsNet);
    w.loCents = w.closingCents - half;
    w.hiCents = w.closingCents + half;
    w.belowMinimum = minimumCents > 0 && w.closingCents < minimumCents;
    if (w.closingCents < low.cents) low = { cents: w.closingCents, date: w.end, weekIndex: w.index };
    if (w.belowMinimum) {
      const short = minimumCents - w.closingCents;
      if (!firstBreach) firstBreach = { weekIndex: w.index, date: w.end, shortfallCents: short };
      if (short > maxShort) maxShort = short;
    }
    if (w.closingCents < 0) neg += 1;
  }

  let dayBal = openingCents;
  let zeroCashDate: string | null = null;
  for (const d of days) {
    d.openingCents = dayBal;
    d.closingCents = dayBal + d.inflowsCents - d.outflowsCents;
    dayBal = d.closingCents;
    if (zeroCashDate === null && d.closingCents < 0) zeroCashDate = d.date;
  }

  const inflows = weeks.reduce((s, w) => s + w.inflowsCents, 0);
  const outflows = weeks.reduce((s, w) => s + w.outflowsCents, 0);
  return {
    scopeId,
    name,
    openingCents,
    minimumCents,
    weeks,
    days,
    closingCents: bal,
    totals: { inflowsCents: inflows, outflowsCents: outflows, netCents: inflows - outflows },
    byCategory,
    lowPoint: low,
    firstBreach,
    maxShortfallCents: maxShort,
    negativeWeekCount: neg,
    zeroCashDate,
    itemCount: count,
  };
}

export function buildCashForecast(input: EngineInput): CashForecast {
  const weeksN = input.horizonWeeks ?? HORIZON_WEEKS;
  const today = input.today;
  const anchor = mondayOf(today);
  const horizonEnd = horizonEndOf(today, weeksN);
  const mape = Math.max(0, Math.min(1, input.mape ?? 0));
  const ids = new Set(input.companies.map((c) => c.id));

  const inScope = input.items.filter((i) => i.companyId === null || ids.has(i.companyId));
  const beyond = { inflowsCents: 0, outflowsCents: 0, count: 0 };
  for (const it of inScope) {
    if (it.date > horizonEnd) {
      beyond.count += 1;
      if (it.direction === 'IN') beyond.inflowsCents += it.amountCents;
      else beyond.outflowsCents += it.amountCents;
    }
  }

  const companies = input.companies.map((c) =>
    buildScope(c.id, c.name, c.openingCents, c.minimumCents, inScope.filter((i) => i.companyId === c.id), today, anchor, horizonEnd, weeksN, mape),
  );

  const excluded: ForecastItem[] = [];
  const combinedItems: ForecastItem[] = [];
  for (const it of inScope) {
    if (it.counterpartyCompanyId && ids.has(it.counterpartyCompanyId) && it.counterpartyCompanyId !== it.companyId) excluded.push(it);
    else combinedItems.push(it);
  }
  const combined = buildScope(
    'combined',
    input.companies.length === 1 ? input.companies[0].name : 'All companies',
    input.companies.reduce((s, c) => s + c.openingCents, 0),
    input.companies.reduce((s, c) => s + Math.max(0, c.minimumCents), 0),
    combinedItems,
    today,
    anchor,
    horizonEnd,
    weeksN,
    mape,
  );

  const inWin = (i: ForecastItem) => i.date >= today && i.date <= horizonEnd;
  return {
    today,
    anchorDate: anchor,
    horizonEnd,
    horizonWeeks: weeksN,
    engineVersion: ENGINE_VERSION,
    combined,
    companies,
    items: inScope.filter(inWin).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.amountCents - a.amountCents)),
    combinedExcludedKeys: excluded.map((i) => i.key),
    intercompanyExcluded: {
      count: excluded.filter(inWin).length,
      inflowsCents: excluded.filter((i) => inWin(i) && i.direction === 'IN').reduce((s, i) => s + i.amountCents, 0),
      outflowsCents: excluded.filter((i) => inWin(i) && i.direction === 'OUT').reduce((s, i) => s + i.amountCents, 0),
    },
    beyondHorizon: beyond,
  };
}

/** Top N receipts / disbursements across the horizon for a scope. */
export function topItems(f: CashForecast, scopeId: string, direction: 'IN' | 'OUT', n = 10): ForecastItem[] {
  const excluded = new Set(f.combinedExcludedKeys);
  return f.items
    .filter((i) => i.direction === direction && (scopeId === 'combined' ? !excluded.has(i.key) : i.companyId === scopeId))
    .sort((a, b) => b.amountCents - a.amountCents)
    .slice(0, n);
}

/** Opening → categories → closing bridge steps (sum ties exactly). */
export function forecastBridge(s: ScopeForecast): Array<{ key: string; label: string; kind: 'start' | 'delta' | 'end'; value: number }> {
  const steps: Array<{ key: string; label: string; kind: 'start' | 'delta' | 'end'; value: number }> = [
    { key: 'opening', label: 'Cash today', kind: 'start', value: s.openingCents },
  ];
  const cats = Object.entries(s.byCategory) as Array<[Category, number]>;
  const signed = cats.map(([c, v]) => ({ c, v: (['AR', 'RECURRING_AR', 'DEPOSIT', 'OTHER_IN', 'TRANSFER_IN', 'LINE_DRAW'] as Category[]).includes(c) ? v : -v }));
  signed.sort((a, b) => (a.v >= 0 && b.v < 0 ? -1 : a.v < 0 && b.v >= 0 ? 1 : Math.abs(b.v) - Math.abs(a.v)));
  for (const { c, v } of signed) if (v !== 0) steps.push({ key: c, label: CATEGORY_LABEL[c], kind: 'delta', value: v });
  steps.push({ key: 'closing', label: `Week ${s.weeks.length} closing`, kind: 'end', value: s.closingCents });
  return steps;
}
