/**
 * Driver-based cash forecast — pure projection engine.
 *
 * A deeper companion to the 13-week direct forecast (`lib/cash/forecast.ts`).
 * Where that engine buckets open AR/AP purely by due date, this one projects
 * cash from the underlying DRIVERS:
 *
 *   • collections  — open receivables shifted by a collection lag (DSO drift)
 *   • disbursements — open payables shifted by a payment lag, PLUS recurring
 *                     obligations (payroll, debt service, leases, recurring bills)
 *                     expanded across the horizon by their cadence
 *   • opening cash  — supplied by the caller (live bank balances)
 *   • adjustments   — optional manual what-if overlays per week
 *
 * It rolls a weekly opening → collections − disbursements → closing balance,
 * flags any week that ends below a minimum cash buffer (shortfall), and returns
 * a collections-vs-disbursements waterfall plus per-category detail for the UI.
 *
 * No I/O. Money is bigint cents throughout — never floating point.
 */

import { mondayOf, parseIsoDate } from '@/lib/cash/forecast';

export const DEFAULT_HORIZON_WEEKS = 13;

export type FlowCategory = 'AR' | 'AP' | 'PAYROLL' | 'DEBT' | 'LEASE' | 'RECURRING' | 'ADJUSTMENT' | 'OTHER';

export type Cadence = 'WEEKLY' | 'BIWEEKLY' | 'SEMIMONTHLY' | 'MONTHLY' | 'QUARTERLY' | 'ANNUALLY';

/** An open receivable expected to collect. `amountCents` is positive. */
export interface ForecastReceivable {
  id: string;
  label: string;
  party: string;
  amountCents: number;
  dueDate: string; // yyyy-mm-dd
  /** Explicit expected-collection date; when omitted, dueDate + collectionLagDays. */
  expectedDate?: string;
}

/** An open payable expected to be paid. `amountCents` is positive. */
export interface ForecastPayable {
  id: string;
  label: string;
  party: string;
  amountCents: number;
  dueDate: string;
  expectedDate?: string;
  category?: FlowCategory; // defaults to 'AP'
}

/**
 * A recurring cash obligation/receipt. `amountCents` is SIGNED: positive is a
 * cash inflow (rare — e.g. a recurring customer draw), negative is an outflow
 * (payroll, debt service, lease). Occurrences are generated from `nextDate`
 * forward by `cadence` until the horizon end (or `endDate`, if earlier).
 */
export interface RecurringFlow {
  id: string;
  label: string;
  amountCents: number;
  cadence: Cadence;
  nextDate: string;
  category: FlowCategory;
  endDate?: string;
}

/** A manual per-week what-if overlay. `amountCents` signed (+ in / − out). */
export interface ForecastAdjustment {
  id: string;
  label: string;
  weekIndex: number; // 0-based
  amountCents: number;
  category?: FlowCategory;
}

export interface DriverForecastInput {
  openingCashCents: number;
  receivables: ForecastReceivable[];
  payables: ForecastPayable[];
  recurring?: RecurringFlow[];
  adjustments?: ForecastAdjustment[];
  /** Days to shift AR collection beyond the due date (models DSO drift). Default 0. */
  collectionLagDays?: number;
  /** Days to shift AP payment beyond the due date. Default 0. */
  paymentLagDays?: number;
  /** Projection length in weeks. Default 13. */
  horizonWeeks?: number;
  /** Closing balance below this is a shortfall. Default 0. */
  minimumBufferCents?: number;
  /** Override "now" (tests). Defaults to current date. */
  today?: Date;
}

export interface ForecastLineItem {
  id: string;
  label: string;
  party?: string;
  amountCents: number; // positive magnitude
  category: FlowCategory;
  date: string;
}

export interface DriverForecastWeek {
  index: number;
  weekNumber: number;
  startDate: string;
  endDate: string;
  openingCents: number;
  collectionsCents: number;
  disbursementsCents: number;
  netCents: number;
  closingCents: number;
  /** Signed net per category (inflow positive, outflow negative). */
  byCategory: Partial<Record<FlowCategory, number>>;
  collectionItems: ForecastLineItem[];
  disbursementItems: ForecastLineItem[];
  belowBuffer: boolean;
}

export interface DriverForecastResult {
  anchorDate: string;
  horizonWeeks: number;
  openingCashCents: number;
  endingCashCents: number;
  minimumBufferCents: number;
  weeks: DriverForecastWeek[];
  totalCollectionsCents: number;
  totalDisbursementsCents: number;
  lowWaterMarkCents: number;
  lowWaterWeekIndex: number; // -1 when the low is the opening balance
  /** Indexes of weeks that end below the minimum buffer. */
  shortfallWeekIndexes: number[];
  hasShortfall: boolean;
  /** First week that dips below buffer, or -1. */
  firstShortfallWeekIndex: number;
  beyondHorizonCollectionsCents: number;
  beyondHorizonDisbursementsCents: number;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

function addMonths(d: Date, n: number): Date {
  const x = new Date(d);
  const day = x.getUTCDate();
  x.setUTCDate(1);
  x.setUTCMonth(x.getUTCMonth() + n);
  // Clamp to the last valid day of the target month (e.g. Jan 31 + 1mo → Feb 28).
  const lastDay = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate();
  x.setUTCDate(Math.min(day, lastDay));
  return x;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function nextOccurrence(d: Date, cadence: Cadence): Date {
  switch (cadence) {
    case 'WEEKLY':
      return addDays(d, 7);
    case 'BIWEEKLY':
      return addDays(d, 14);
    case 'SEMIMONTHLY':
      return addDays(d, 15); // ~twice a month; deterministic 15-day step
    case 'MONTHLY':
      return addMonths(d, 1);
    case 'QUARTERLY':
      return addMonths(d, 3);
    case 'ANNUALLY':
      return addMonths(d, 12);
    default: {
      const _never: never = cadence;
      return _never;
    }
  }
}

/** 0-based week index for a date given the anchor Monday; -1 if beyond horizon. Past → 0. */
function bucketFor(dateIso: string, anchor: Date, horizonWeeks: number): number {
  const t = parseIsoDate(dateIso).getTime();
  if (t < anchor.getTime()) return 0;
  const idx = Math.floor((t - anchor.getTime()) / (7 * 86_400_000));
  return idx < horizonWeeks ? idx : -1;
}

export function buildDriverForecast(input: DriverForecastInput): DriverForecastResult {
  const horizonWeeks = input.horizonWeeks ?? DEFAULT_HORIZON_WEEKS;
  const buffer = input.minimumBufferCents ?? 0;
  const collectionLag = input.collectionLagDays ?? 0;
  const paymentLag = input.paymentLagDays ?? 0;
  const anchor = mondayOf(input.today ?? new Date());
  const horizonEnd = addDays(anchor, horizonWeeks * 7 - 1);

  const weeks: DriverForecastWeek[] = [];
  for (let i = 0; i < horizonWeeks; i++) {
    const start = addDays(anchor, i * 7);
    weeks.push({
      index: i,
      weekNumber: i + 1,
      startDate: isoDate(start),
      endDate: isoDate(addDays(start, 6)),
      openingCents: 0,
      collectionsCents: 0,
      disbursementsCents: 0,
      netCents: 0,
      closingCents: 0,
      byCategory: {},
      collectionItems: [],
      disbursementItems: [],
      belowBuffer: false,
    });
  }

  let beyondCollections = 0;
  let beyondDisbursements = 0;

  const addCategory = (w: DriverForecastWeek, cat: FlowCategory, signed: number) => {
    w.byCategory[cat] = (w.byCategory[cat] ?? 0) + signed;
  };

  // ── Collections: receivables shifted by the collection lag ──
  for (const r of input.receivables) {
    const amount = Math.abs(Number(r.amountCents ?? 0));
    if (amount === 0) continue;
    const when = r.expectedDate ?? isoDate(addDays(parseIsoDate(r.dueDate), collectionLag));
    const b = bucketFor(when, anchor, horizonWeeks);
    if (b < 0) {
      beyondCollections += amount;
      continue;
    }
    const w = weeks[b];
    w.collectionsCents += amount;
    w.collectionItems.push({ id: r.id, label: r.label, party: r.party, amountCents: amount, category: 'AR', date: when });
    addCategory(w, 'AR', amount);
  }

  // ── Disbursements: payables shifted by the payment lag ──
  for (const p of input.payables) {
    const amount = Math.abs(Number(p.amountCents ?? 0));
    if (amount === 0) continue;
    const cat = p.category ?? 'AP';
    const when = p.expectedDate ?? isoDate(addDays(parseIsoDate(p.dueDate), paymentLag));
    const b = bucketFor(when, anchor, horizonWeeks);
    if (b < 0) {
      beyondDisbursements += amount;
      continue;
    }
    const w = weeks[b];
    w.disbursementsCents += amount;
    w.disbursementItems.push({ id: p.id, label: p.label, party: p.party, amountCents: amount, category: cat, date: when });
    addCategory(w, cat, -amount);
  }

  // ── Recurring obligations expanded across the horizon ──
  for (const rec of input.recurring ?? []) {
    const signed = Number(rec.amountCents ?? 0);
    if (signed === 0) continue;
    const endLimit = rec.endDate ? parseIsoDate(rec.endDate) : horizonEnd;
    const stopAt = endLimit.getTime() < horizonEnd.getTime() ? endLimit : horizonEnd;
    let occ = parseIsoDate(rec.nextDate);
    // Guard against pathological inputs (nextDate far in the past): fast-forward.
    let guard = 0;
    while (occ.getTime() < anchor.getTime() && guard < 520) {
      occ = nextOccurrence(occ, rec.cadence);
      guard += 1;
    }
    while (occ.getTime() <= stopAt.getTime() && guard < 520) {
      const b = bucketFor(isoDate(occ), anchor, horizonWeeks);
      if (b >= 0) {
        const w = weeks[b];
        const magnitude = Math.abs(signed);
        const item: ForecastLineItem = { id: `${rec.id}:${isoDate(occ)}`, label: rec.label, amountCents: magnitude, category: rec.category, date: isoDate(occ) };
        if (signed >= 0) {
          w.collectionsCents += magnitude;
          w.collectionItems.push(item);
          addCategory(w, rec.category, magnitude);
        } else {
          w.disbursementsCents += magnitude;
          w.disbursementItems.push(item);
          addCategory(w, rec.category, -magnitude);
        }
      }
      occ = nextOccurrence(occ, rec.cadence);
      guard += 1;
    }
  }

  // ── Manual per-week what-if overlays ──
  for (const adj of input.adjustments ?? []) {
    if (adj.weekIndex < 0 || adj.weekIndex >= horizonWeeks) continue;
    const w = weeks[adj.weekIndex];
    const signed = Number(adj.amountCents ?? 0);
    if (signed === 0) continue;
    const cat = adj.category ?? 'ADJUSTMENT';
    const magnitude = Math.abs(signed);
    const item: ForecastLineItem = { id: adj.id, label: adj.label, amountCents: magnitude, category: cat, date: w.startDate };
    if (signed >= 0) {
      w.collectionsCents += magnitude;
      w.collectionItems.push(item);
      addCategory(w, cat, magnitude);
    } else {
      w.disbursementsCents += magnitude;
      w.disbursementItems.push(item);
      addCategory(w, cat, -magnitude);
    }
  }

  // ── Roll the balance forward; detect the low-water mark and shortfalls ──
  let balance = input.openingCashCents;
  let low = input.openingCashCents;
  let lowIdx = -1;
  const shortfalls: number[] = [];

  for (const w of weeks) {
    w.openingCents = balance;
    w.netCents = w.collectionsCents - w.disbursementsCents;
    w.closingCents = balance + w.netCents;
    balance = w.closingCents;

    w.collectionItems.sort((a, b) => b.amountCents - a.amountCents);
    w.disbursementItems.sort((a, b) => b.amountCents - a.amountCents);

    if (w.closingCents < low) {
      low = w.closingCents;
      lowIdx = w.index;
    }
    if (w.closingCents < buffer) {
      w.belowBuffer = true;
      shortfalls.push(w.index);
    }
  }

  const totalCollections = weeks.reduce((s, w) => s + w.collectionsCents, 0);
  const totalDisbursements = weeks.reduce((s, w) => s + w.disbursementsCents, 0);

  return {
    anchorDate: isoDate(anchor),
    horizonWeeks,
    openingCashCents: input.openingCashCents,
    endingCashCents: balance,
    minimumBufferCents: buffer,
    weeks,
    totalCollectionsCents: totalCollections,
    totalDisbursementsCents: totalDisbursements,
    lowWaterMarkCents: low,
    lowWaterWeekIndex: lowIdx,
    shortfallWeekIndexes: shortfalls,
    hasShortfall: shortfalls.length > 0,
    firstShortfallWeekIndex: shortfalls.length > 0 ? shortfalls[0] : -1,
    beyondHorizonCollectionsCents: beyondCollections,
    beyondHorizonDisbursementsCents: beyondDisbursements,
  };
}
