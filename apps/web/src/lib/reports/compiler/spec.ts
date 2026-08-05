/**
 * NL Report Compiler — the allowlisted REPORT-SPEC catalog + the DETERMINISTIC
 * period expander. This is the safety kernel of the compiler (same doctrine as
 * lib/nl/metric-catalog.ts): the AI model NEVER computes a number and NEVER
 * writes SQL. Its ONLY job is to map the user's sentence to a list of
 * ALLOWLISTED report specs — a report type + basis + a RELATIVE period
 * descriptor drawn from a fixed grammar. Everything downstream is deterministic:
 *
 *   1. This module's `expandSpec()` turns each relative descriptor
 *      ("last 3 fiscal years", "this year through June") into CONCRETE date
 *      ranges — fiscal-year aware (respecting the org's fiscal_year_start_month).
 *   2. The existing RLS-scoped report engines (lib/reports/compiler/run.ts) then
 *      produce every figure from the general ledger.
 *
 * If the model returns a report type or basis that is not on this allowlist, the
 * parser ABSTAINS — it never guesses. No model-authored dates, no model-authored
 * money. The numbers in a descriptor (n, offset, year, throughMonth) are
 * STRUCTURAL period parameters bounded by Zod, not financial values.
 */

import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Report catalog (the allowlist)
// ─────────────────────────────────────────────────────────────────────────────

export type ReportType =
  | 'INCOME_STATEMENT'
  | 'BALANCE_SHEET'
  | 'TRIAL_BALANCE'
  | 'SALES_BY_CUSTOMER'
  | 'AR_AGING'
  | 'AP_AGING'
  | 'CASH_FLOW';

export type ReportBasis = 'ACCRUAL' | 'CASH';

/** RANGE → needs a start+end window; AS_OF → a point in time (period end);
 *  SNAPSHOT → always "as of today" (open items don't take a historical date). */
export type PeriodKind = 'RANGE' | 'AS_OF' | 'SNAPSHOT';

/** FULL → the engine has a real cash-basis path; NA → basis is not meaningful
 *  for this report (accrual is the only sensible presentation); UNAVAILABLE →
 *  cash basis is conceptually valid but this engine can't produce it yet, so a
 *  cash request is honored on accrual WITH a visible warning (never silently). */
export type CashBasisSupport = 'FULL' | 'NA' | 'UNAVAILABLE';

export interface ReportCatalogEntry {
  id: ReportType;
  title: string;
  /** One-line description injected into the classifier prompt. */
  description: string;
  periodKind: PeriodKind;
  /** Whether an accrual/cash toggle is meaningful at all. */
  supportsBasis: boolean;
  cashBasis: CashBasisSupport;
}

export const REPORT_CATALOG: Record<ReportType, ReportCatalogEntry> = {
  INCOME_STATEMENT: {
    id: 'INCOME_STATEMENT',
    title: 'Income Statement (P&L)',
    description:
      'Profit & Loss / income statement for a period: revenue, COGS, gross profit, operating expenses, net income. Supports accrual OR cash basis.',
    periodKind: 'RANGE',
    supportsBasis: true,
    cashBasis: 'FULL',
  },
  BALANCE_SHEET: {
    id: 'BALANCE_SHEET',
    title: 'Balance Sheet',
    description:
      'Balance sheet as of a date: assets, liabilities, and equity. Always presented on accrual basis.',
    periodKind: 'AS_OF',
    supportsBasis: false,
    cashBasis: 'NA',
  },
  TRIAL_BALANCE: {
    id: 'TRIAL_BALANCE',
    title: 'Trial Balance',
    description:
      'Trial balance as of a date: every account with cumulative debits, credits, and net balance; confirms debits equal credits.',
    periodKind: 'AS_OF',
    supportsBasis: false,
    cashBasis: 'NA',
  },
  SALES_BY_CUSTOMER: {
    id: 'SALES_BY_CUSTOMER',
    title: 'Sales by Customer',
    description:
      'Invoiced sales for a period, totaled per customer and ranked. Based on issued invoices (accrual).',
    periodKind: 'RANGE',
    supportsBasis: false,
    cashBasis: 'UNAVAILABLE',
  },
  AR_AGING: {
    id: 'AR_AGING',
    title: 'A/R Aging',
    description:
      'Accounts receivable aging (what customers currently owe) bucketed current / 1-30 / 31-60 / 61-90 / 90+. A current snapshot.',
    periodKind: 'SNAPSHOT',
    supportsBasis: false,
    cashBasis: 'NA',
  },
  AP_AGING: {
    id: 'AP_AGING',
    title: 'A/P Aging',
    description:
      'Accounts payable aging (what you currently owe vendors) bucketed current / 1-30 / 31-60 / 61-90 / 90+. A current snapshot.',
    periodKind: 'SNAPSHOT',
    supportsBasis: false,
    cashBasis: 'NA',
  },
  CASH_FLOW: {
    id: 'CASH_FLOW',
    title: 'Statement of Cash Flows',
    description:
      'Statement of cash flows (indirect method) for a period: operating, investing, and financing activities.',
    periodKind: 'RANGE',
    supportsBasis: false,
    cashBasis: 'NA',
  },
};

export const REPORT_TYPES = Object.keys(REPORT_CATALOG) as ReportType[];

// ─────────────────────────────────────────────────────────────────────────────
// Period descriptors — the FIXED grammar the model may emit (RELATIVE only).
// The model never emits a concrete date except EXPLICIT (which is the user
// literally stating dates — transcription, not computation).
// ─────────────────────────────────────────────────────────────────────────────

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

export const periodDescriptorSchema = z.discriminatedUnion('type', [
  /** The N full fiscal years immediately before the current one (chronological). */
  z.object({ type: z.literal('LAST_N_FISCAL_YEARS'), n: z.number().int().min(1).max(10) }),
  /** A single fiscal year by offset from the current one (0 = current, -1 = prior). */
  z.object({ type: z.literal('FISCAL_YEAR'), offset: z.number().int().min(-20).max(0) }),
  /** A fiscal year named by the calendar year it starts in (e.g. the user said "2023"). */
  z.object({ type: z.literal('CALENDAR_YEAR'), year: z.number().int().min(1990).max(2100) }),
  /** Current fiscal year to date; optional throughMonth (1-12) caps it (e.g. "through June"). */
  z.object({ type: z.literal('FISCAL_YTD'), throughMonth: z.number().int().min(1).max(12).optional() }),
  /** Trailing N whole months ending with the last completed month. */
  z.object({ type: z.literal('LAST_N_MONTHS'), n: z.number().int().min(1).max(60) }),
  /** User literally stated the exact dates. */
  z.object({ type: z.literal('EXPLICIT'), startDate: isoDate, endDate: isoDate }),
]);
export type PeriodDescriptor = z.infer<typeof periodDescriptorSchema>;

/** A single report spec as emitted by the model (pre-expansion). */
export const reportSpecSchema = z.object({
  report: z.enum(REPORT_TYPES as [ReportType, ...ReportType[]]),
  basis: z.enum(['ACCRUAL', 'CASH']).default('ACCRUAL'),
  periods: z.array(periodDescriptorSchema).min(1).max(12),
});
export type ReportSpec = z.infer<typeof reportSpecSchema>;

/** The full model output: an ordered list of report specs (or empty → abstain). */
export const compilerParseSchema = z.object({
  reports: z.array(reportSpecSchema).max(20),
});
export type CompilerParse = z.infer<typeof compilerParseSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Resolved (concrete) shapes — produced by the deterministic expander, sent to
// the PDF route. The PDF route RE-VALIDATES these against the allowlist before
// running any engine (never trust the client).
// ─────────────────────────────────────────────────────────────────────────────

export const resolvedPeriodSchema = z.object({
  startDate: isoDate,
  endDate: isoDate,
  /** The point-in-time date for AS_OF/SNAPSHOT reports (== endDate for ranges). */
  asOfDate: isoDate,
  /** Human label, e.g. "FY2025 · Jan 1 – Dec 31, 2025" or "As of Dec 31, 2025". */
  label: z.string().min(1).max(160),
});
export type ResolvedPeriod = z.infer<typeof resolvedPeriodSchema>;

export const resolvedSpecSchema = z.object({
  report: z.enum(REPORT_TYPES as [ReportType, ...ReportType[]]),
  basis: z.enum(['ACCRUAL', 'CASH']),
  periods: z.array(resolvedPeriodSchema).min(1).max(12),
  /** Set when the requested basis can't be produced and accrual is substituted. */
  cashWarning: z.string().nullable().optional(),
});
export type ResolvedSpec = z.infer<typeof resolvedSpecSchema>;

export const resolvedPackSchema = z.object({
  entityLabel: z.string().max(200).default('All Companies (Consolidated)'),
  locationIds: z.array(z.string().max(80)).max(50).default([]),
  specs: z.array(resolvedSpecSchema).min(1).max(20),
});
export type ResolvedPack = z.infer<typeof resolvedPackSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Fiscal-year-aware date math (pure, deterministic, unit-tested).
// Fiscal years are NUMBERED BY THE CALENDAR YEAR THEY START IN. For a calendar
// filer (fiscal_year_start_month = 1) FY2025 = Jan 1 – Dec 31, 2025.
// ─────────────────────────────────────────────────────────────────────────────

interface YMD { y: number; m: number; d: number }

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
function iso(p: YMD): string {
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}
function parseISO(s: string): YMD {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}
/** Last calendar day of 1-based month `m` in year `y`. */
function lastDay(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
/** Shift a 1-based (year, month) by `delta` months. */
function shiftMonth(y: number, m: number, delta: number): { y: number; m: number } {
  const idx = y * 12 + (m - 1) + delta;
  return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
}

/** The fiscal-year number that a given date falls in. */
export function fiscalYearOf(date: YMD, startMonth: number): number {
  return date.m >= startMonth ? date.y : date.y - 1;
}

/** Concrete start/end of fiscal year `fyNum` for a filer whose FY starts in `startMonth`. */
export function fiscalYearRange(fyNum: number, startMonth: number): { start: YMD; end: YMD } {
  if (startMonth === 1) {
    return { start: { y: fyNum, m: 1, d: 1 }, end: { y: fyNum, m: 12, d: 31 } };
  }
  const endM = startMonth - 1;
  const endY = fyNum + 1;
  return { start: { y: fyNum, m: startMonth, d: 1 }, end: { y: endY, m: endM, d: lastDay(endY, endM) } };
}

function todayYMD(refISO?: string): YMD {
  if (refISO) return parseISO(refISO);
  const n = new Date();
  return { y: n.getUTCFullYear(), m: n.getUTCMonth() + 1, d: n.getUTCDate() };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Dec 31, 2025" from an ISO date. */
export function humanDate(isoStr: string): string {
  const p = parseISO(isoStr);
  return `${MONTHS[p.m - 1]} ${p.d}, ${p.y}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Descriptor → concrete range(s). Each raw entry carries an optional short tag
// (e.g. "FY2025") that the label formatter combines with the period kind.
// ─────────────────────────────────────────────────────────────────────────────

interface RawRange { startDate: string; endDate: string; tag: string }

/** Clamp `end` so it never runs past `cap` (both ISO). */
function minISO(a: string, b: string): string {
  return a <= b ? a : b;
}

export function expandDescriptor(desc: PeriodDescriptor, startMonth: number, refISO?: string): RawRange[] {
  const ref = todayYMD(refISO);
  const currentFY = fiscalYearOf(ref, startMonth);

  switch (desc.type) {
    case 'LAST_N_FISCAL_YEARS': {
      const out: RawRange[] = [];
      for (let fy = currentFY - desc.n; fy <= currentFY - 1; fy++) {
        const r = fiscalYearRange(fy, startMonth);
        out.push({ startDate: iso(r.start), endDate: iso(r.end), tag: `FY${fy}` });
      }
      return out;
    }
    case 'FISCAL_YEAR': {
      const fy = currentFY + desc.offset;
      const r = fiscalYearRange(fy, startMonth);
      // The current fiscal year is not yet complete — cap the end at today.
      const end = desc.offset === 0 ? minISO(iso(r.end), iso(ref)) : iso(r.end);
      return [{ startDate: iso(r.start), endDate: end, tag: desc.offset === 0 ? `FY${fy} (YTD)` : `FY${fy}` }];
    }
    case 'CALENDAR_YEAR': {
      const r = fiscalYearRange(desc.year, startMonth);
      return [{ startDate: iso(r.start), endDate: iso(r.end), tag: `FY${desc.year}` }];
    }
    case 'FISCAL_YTD': {
      const r = fiscalYearRange(currentFY, startMonth);
      let end: string;
      if (desc.throughMonth != null) {
        // The month `throughMonth` belongs to the FY's start year if it is at or
        // after the start month, else the following calendar year.
        const y = desc.throughMonth >= startMonth ? currentFY : currentFY + 1;
        const capped = minISO(`${y}-${pad(desc.throughMonth)}-${pad(lastDay(y, desc.throughMonth))}`, iso(r.end));
        end = capped;
      } else {
        end = minISO(iso(ref), iso(r.end));
      }
      const monthTag = desc.throughMonth != null ? ` through ${MONTHS[desc.throughMonth - 1]}` : ' YTD';
      return [{ startDate: iso(r.start), endDate: end, tag: `FY${currentFY}${monthTag}` }];
    }
    case 'LAST_N_MONTHS': {
      // End = last completed month; start = (n-1) months before that, day 1.
      const lastMonth = shiftMonth(ref.y, ref.m, -1);
      const end: YMD = { y: lastMonth.y, m: lastMonth.m, d: lastDay(lastMonth.y, lastMonth.m) };
      const startMo = shiftMonth(end.y, end.m, -(desc.n - 1));
      const start: YMD = { y: startMo.y, m: startMo.m, d: 1 };
      return [{ startDate: iso(start), endDate: iso(end), tag: `Trailing ${desc.n} mo` }];
    }
    case 'EXPLICIT': {
      // Guard against an inverted range from a fumbled prompt.
      const start = minISO(desc.startDate, desc.endDate);
      const end = start === desc.startDate ? desc.endDate : desc.startDate;
      return [{ startDate: start, endDate: end, tag: '' }];
    }
  }
}

/** Format the human label for a resolved period given the report's period kind. */
function labelFor(kind: PeriodKind, raw: RawRange, refISO?: string): string {
  if (kind === 'SNAPSHOT') {
    return `As of ${humanDate(iso(todayYMD(refISO)))}`;
  }
  if (kind === 'AS_OF') {
    return raw.tag ? `${raw.tag} — As of ${humanDate(raw.endDate)}` : `As of ${humanDate(raw.endDate)}`;
  }
  // RANGE
  const range = `${humanDate(raw.startDate)} – ${humanDate(raw.endDate)}`;
  return raw.tag ? `${raw.tag} · ${range}` : range;
}

// ─────────────────────────────────────────────────────────────────────────────
// expandSpec — the whole-spec expander the compile route calls.
// ─────────────────────────────────────────────────────────────────────────────

export function expandSpec(spec: ReportSpec, startMonth: number, refISO?: string): ResolvedSpec {
  const entry = REPORT_CATALOG[spec.report];

  // Cash basis: honor when the engine truly supports it; otherwise substitute
  // accrual and surface a warning — NEVER present accrual data labeled "cash".
  let cashWarning: string | null = null;
  if (spec.basis === 'CASH' && entry.cashBasis !== 'FULL') {
    cashWarning =
      entry.cashBasis === 'NA'
        ? `${entry.title} is presented on accrual basis; a cash-basis variant is not applicable.`
        : `Cash basis is not yet available for ${entry.title}; shown on accrual basis.`;
  }

  // SNAPSHOT reports collapse to a single "as of today" section regardless of
  // how many periods were requested — open items don't take a historical date.
  if (entry.periodKind === 'SNAPSHOT') {
    const ref = todayYMD(refISO);
    const today = iso(ref);
    return {
      report: spec.report,
      basis: spec.basis,
      cashWarning,
      periods: [{ startDate: today, endDate: today, asOfDate: today, label: labelFor('SNAPSHOT', { startDate: today, endDate: today, tag: '' }, refISO) }],
    };
  }

  const seen = new Set<string>();
  const periods: ResolvedPeriod[] = [];
  for (const desc of spec.periods) {
    for (const raw of expandDescriptor(desc, startMonth, refISO)) {
      const key = `${raw.startDate}|${raw.endDate}`;
      if (seen.has(key)) continue; // de-dupe overlapping descriptors
      seen.add(key);
      periods.push({
        startDate: raw.startDate,
        endDate: raw.endDate,
        asOfDate: raw.endDate,
        label: labelFor(entry.periodKind, raw, refISO),
      });
    }
  }
  // Chronological order for a clean pack.
  periods.sort((a, b) => a.endDate.localeCompare(b.endDate));

  return { report: spec.report, basis: spec.basis, cashWarning, periods };
}

/** Expand a whole parse into resolved specs (skips any spec that yields no periods). */
export function expandParse(parse: CompilerParse, startMonth: number, refISO?: string): ResolvedSpec[] {
  return parse.reports.map((s) => expandSpec(s, startMonth, refISO)).filter((s) => s.periods.length > 0);
}

/** The abstain message — lists exactly what the compiler can produce. */
export function compilerAbstainMessage(): string {
  const list = REPORT_TYPES.map((t) => `• ${REPORT_CATALOG[t].title}`).join('\n');
  return (
    "I couldn't map that to a report pack I can build. I can compile these reports " +
    'across your organization, on accrual (and cash where supported), for any set of periods:\n' +
    list
  );
}
