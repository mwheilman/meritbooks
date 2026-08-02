/**
 * Recurring journal-entry templates — PURE, deterministic, unit-tested.
 *
 * A recurring JE template is a *balanced line set* (each line an account + a debit
 * OR a credit in bigint cents, with optional dimensions) plus a *cadence*
 * (monthly / quarterly) and a start (and optional end). Unlike prepaid
 * amortization, a recurring accrual posts the SAME balanced entry every period —
 * a fixed accrual, or a fixed amount straight-line-allocated across departments /
 * locations. It never decrements a balance; it repeats.
 *
 * This module owns three concerns and touches no I/O:
 *   1. `validateBalance` — the double-entry gate a template must pass before it can
 *      be persisted or generated: >= 2 one-sided lines, non-negative integer cents,
 *      total > 0, and debits === credits. The DB `check_journal_balance()` trigger
 *      is the final guarantor at post time; this is the same check up front so a
 *      human never builds an un-postable template.
 *   2. occurrence math — `enumerateOccurrences` / `nextDuePeriods`: which fiscal
 *      months a template is due in, stepping by its cadence from the start month,
 *      capped by an optional end and by an `asOf` cutoff, minus periods already
 *      generated. The post date is month-end (accrual convention), matching the
 *      prepaid engine.
 *   3. allocation — `allocateEvenly` / `buildAllocatedAccrualLines`: turn "accrue
 *      $X, split across these N cost centers, offset to this liability" into a
 *      balanced line set (floor split, remainder on the last bucket so it sums to
 *      exactly the total). A single bucket is just a plain fixed accrual.
 *
 * All money is bigint cents; nothing here does floating-point money arithmetic.
 */

export type RecurringCadence = 'MONTHLY' | 'QUARTERLY';

export interface RecurringJeLine {
  account_id: string;
  debit_cents: number;
  credit_cents: number;
  /** Line location; defaults to the template location when built. */
  location_id?: string | null;
  department_id?: string | null;
  class_id?: string | null;
  memo?: string | null;
}

export interface RecurringJeTemplate {
  cadence: RecurringCadence;
  /** YYYY-MM-DD — the first occurrence's month. */
  startDate: string;
  /** Inclusive last calendar date an occurrence month may fall on. Null = open-ended. */
  endDate?: string | null;
  lines: RecurringJeLine[];
}

export interface RecurringPeriod {
  /** 0-based occurrence index from the start month. */
  index: number;
  year: number;
  /** 1..12 */
  month: number;
  /** 'YYYY-MM' fiscal bucket. */
  period: string;
  /** last calendar day of the occurrence month, 'YYYY-MM-DD' — the JE post date. */
  postDate: string;
}

export type BalanceResult =
  | { ok: true; totalCents: number; lineCount: number }
  | { ok: false; error: string };

/** Thrown for un-enumerable occurrence inputs (bad dates / unbounded). */
export class RecurringJeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecurringJeError';
  }
}

// ─── date helpers (UTC, calendar-exact) ──────────────────────────────────────

function parseUTC(date: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new RecurringJeError(`Invalid date "${date}" (expected YYYY-MM-DD)`);
  const [, y, mo, d] = m;
  const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (
    dt.getUTCFullYear() !== Number(y) ||
    dt.getUTCMonth() !== Number(mo) - 1 ||
    dt.getUTCDate() !== Number(d)
  ) {
    throw new RecurringJeError(`Impossible calendar date "${date}"`);
  }
  return dt;
}

/** Absolute month index (year*12 + month0) for a YYYY-MM-DD date. */
function monthIndexOf(date: string): number {
  const d = parseUTC(date);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}

/** Year + 1-based month `n` months after the given start month. */
function addMonths(startYear: number, startMonth1: number, n: number): { year: number; month: number } {
  const base = startYear * 12 + (startMonth1 - 1) + n;
  return { year: Math.floor(base / 12), month: (base % 12) + 1 };
}

function lastDayOfMonth(year: number, month1: number): string {
  return new Date(Date.UTC(year, month1, 0)).toISOString().slice(0, 10);
}

function periodKey(year: number, month1: number): string {
  return `${year}-${String(month1).padStart(2, '0')}`;
}

// ─── balance validation (the double-entry gate) ──────────────────────────────

/**
 * Validate a recurring template's line set as a balanced journal entry. Same rule
 * the DB enforces at post time — applied up front so a template is never saved in
 * an un-postable state.
 */
export function validateBalance(lines: readonly RecurringJeLine[]): BalanceResult {
  if (!Array.isArray(lines) || lines.length < 2) {
    return { ok: false, error: 'A journal entry needs at least two lines' };
  }
  let totalDebits = 0;
  let totalCredits = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.account_id) return { ok: false, error: `Line ${i + 1}: choose an account` };
    const d = l.debit_cents;
    const c = l.credit_cents;
    if (!Number.isInteger(d) || !Number.isInteger(c)) {
      return { ok: false, error: `Line ${i + 1}: amounts must be whole cents` };
    }
    if (d < 0 || c < 0) return { ok: false, error: `Line ${i + 1}: amounts cannot be negative` };
    if (d > 0 && c > 0) return { ok: false, error: `Line ${i + 1}: a line is a debit or a credit, not both` };
    if (d === 0 && c === 0) return { ok: false, error: `Line ${i + 1}: enter a debit or a credit amount` };
    totalDebits += d;
    totalCredits += c;
  }
  if (totalDebits !== totalCredits) {
    return { ok: false, error: `Unbalanced: debits ${totalDebits} ≠ credits ${totalCredits}` };
  }
  if (totalDebits === 0) return { ok: false, error: 'Entry has no amounts' };
  return { ok: true, totalCents: totalDebits, lineCount: lines.length };
}

// ─── occurrence math ─────────────────────────────────────────────────────────

/** Months between occurrences for a cadence. */
export function cadenceStepMonths(cadence: RecurringCadence): number {
  return cadence === 'QUARTERLY' ? 3 : 1;
}

const MAX_OCCURRENCES = 600; // defensive cap (≈ 50 yrs monthly) — never infinite.

interface EnumerateOpts {
  /** Inclusive last calendar date an occurrence month may fall on. */
  endDate?: string | null;
  /** Only include occurrences whose month has begun on/before this date. */
  throughAsOf?: string | null;
  /** Hard cap on how many occurrences to return. */
  maxOccurrences?: number;
}

/**
 * Enumerate a template's occurrence periods from its start month, stepping by
 * cadence. Bounded by `endDate` and/or `throughAsOf`; if neither is given it
 * returns up to `maxOccurrences` (default {@link MAX_OCCURRENCES}) so it is never
 * unbounded. An occurrence belongs to a month; its post date is that month-end.
 */
export function enumerateOccurrences(
  startDate: string,
  cadence: RecurringCadence,
  opts: EnumerateOpts = {},
): RecurringPeriod[] {
  const start = parseUTC(startDate);
  const startYear = start.getUTCFullYear();
  const startMonth1 = start.getUTCMonth() + 1;
  const step = cadenceStepMonths(cadence);

  const endIdx = opts.endDate ? monthIndexOf(opts.endDate) : null;
  const asOfIdx = opts.throughAsOf ? monthIndexOf(opts.throughAsOf) : null;
  const cap = Math.min(opts.maxOccurrences ?? MAX_OCCURRENCES, MAX_OCCURRENCES);

  const startIdx = startYear * 12 + (startMonth1 - 1);
  if (endIdx != null && endIdx < startIdx) return [];

  const periods: RecurringPeriod[] = [];
  for (let i = 0; i < cap; i++) {
    const occIdx = startIdx + i * step;
    if (endIdx != null && occIdx > endIdx) break;
    if (asOfIdx != null && occIdx > asOfIdx) break;
    const { year, month } = addMonths(startYear, startMonth1, i * step);
    periods.push({
      index: i,
      year,
      month,
      period: periodKey(year, month),
      postDate: lastDayOfMonth(year, month),
    });
    // When only an asOf cutoff bounds us and we've reached it, stop.
    if (asOfIdx != null && occIdx === asOfIdx) break;
  }
  return periods;
}

/**
 * The occurrence periods that are due on/before `asOf` and have NOT already been
 * generated. `generated` is the set of 'YYYY-MM' keys already produced for this
 * template (from the run ledger) — the double-generate guard mirror of the DB
 * unique index.
 */
export function nextDuePeriods(
  template: RecurringJeTemplate,
  ctx: { asOf: string; generated?: ReadonlySet<string> },
): RecurringPeriod[] {
  const occ = enumerateOccurrences(template.startDate, template.cadence, {
    endDate: template.endDate ?? null,
    throughAsOf: ctx.asOf,
  });
  const generated = ctx.generated;
  return generated ? occ.filter((p) => !generated.has(p.period)) : occ;
}

/** The single next occurrence at/after `asOf` (for display of "next run"). */
export function nextOccurrence(
  template: RecurringJeTemplate,
  fromInclusive: string,
): RecurringPeriod | null {
  const fromIdx = monthIndexOf(fromInclusive);
  const all = enumerateOccurrences(template.startDate, template.cadence, {
    endDate: template.endDate ?? null,
    maxOccurrences: MAX_OCCURRENCES,
  });
  for (const p of all) {
    if (p.year * 12 + (p.month - 1) >= fromIdx) return p;
  }
  return null;
}

// ─── line building + allocation ──────────────────────────────────────────────

/**
 * Materialize a template's stored lines for a period, defaulting each line's
 * location to the template location. The lines are identical every period; only
 * the entry date changes, so this is a pure projection of the stored line set.
 */
export function buildEntryLines(
  lines: readonly RecurringJeLine[],
  defaults: { locationId: string },
): RecurringJeLine[] {
  return lines.map((l) => ({
    account_id: l.account_id,
    debit_cents: l.debit_cents,
    credit_cents: l.credit_cents,
    location_id: l.location_id ?? defaults.locationId,
    department_id: l.department_id ?? null,
    class_id: l.class_id ?? null,
    memo: l.memo ?? null,
  }));
}

/**
 * Split `totalCents` into `count` whole-cent buckets, floor each and put the
 * rounding remainder on the LAST bucket, so the parts always sum to exactly the
 * total. `count` must be >= 1.
 */
export function allocateEvenly(totalCents: number, count: number): number[] {
  if (!Number.isInteger(totalCents) || totalCents <= 0) {
    throw new RecurringJeError('Allocation total must be a positive number of cents');
  }
  if (!Number.isInteger(count) || count < 1) {
    throw new RecurringJeError('Allocation needs at least one bucket');
  }
  const per = Math.floor(totalCents / count);
  const out: number[] = [];
  let remaining = totalCents;
  for (let i = 0; i < count; i++) {
    const amount = i === count - 1 ? remaining : per;
    remaining -= amount;
    out.push(amount);
  }
  return out;
}

export interface AllocationBucket {
  account_id: string;
  department_id?: string | null;
  location_id?: string | null;
  class_id?: string | null;
  /** Optional explicit weight; if any bucket has one, all should. Defaults to equal. */
  weight?: number;
}

export interface BuildAllocatedAccrualInput {
  totalCents: number;
  /** Which side the allocated (multi-bucket) legs land on. The offset takes the other side. */
  allocatedSide: 'debit' | 'credit';
  /** The single offsetting account (e.g. the accrued-liability credit for an expense accrual). */
  offsetAccountId: string;
  offsetDepartmentId?: string | null;
  offsetLocationId?: string | null;
  /** The cost centers / entities to spread across. One bucket = a plain fixed accrual. */
  buckets: AllocationBucket[];
  memo?: string | null;
}

/**
 * Build a balanced line set for a straight-line allocation across departments /
 * locations (or a plain single-bucket fixed accrual). The allocated legs sum to
 * exactly `totalCents`, the offset leg carries the same total on the other side,
 * so `validateBalance` on the result is always ok.
 */
export function buildAllocatedAccrualLines(input: BuildAllocatedAccrualInput): RecurringJeLine[] {
  if (input.buckets.length < 1) throw new RecurringJeError('Provide at least one allocation bucket');
  const total = Math.trunc(input.totalCents);
  if (!Number.isInteger(total) || total <= 0) {
    throw new RecurringJeError('Accrual total must be a positive number of cents');
  }

  // Weighted split when weights are supplied; else even split.
  const weights = input.buckets.map((b) => (typeof b.weight === 'number' ? b.weight : null));
  const useWeights = weights.every((w) => w != null && w > 0);
  let amounts: number[];
  if (useWeights) {
    const wsum = (weights as number[]).reduce((s, w) => s + w, 0);
    amounts = [];
    let assigned = 0;
    for (let i = 0; i < input.buckets.length; i++) {
      const amount =
        i === input.buckets.length - 1
          ? total - assigned
          : Math.floor((total * (weights[i] as number)) / wsum);
      assigned += amount;
      amounts.push(amount);
    }
  } else {
    amounts = allocateEvenly(total, input.buckets.length);
  }

  const allocatedLines: RecurringJeLine[] = input.buckets.map((b, i) => ({
    account_id: b.account_id,
    debit_cents: input.allocatedSide === 'debit' ? amounts[i] : 0,
    credit_cents: input.allocatedSide === 'credit' ? amounts[i] : 0,
    location_id: b.location_id ?? null,
    department_id: b.department_id ?? null,
    class_id: b.class_id ?? null,
    memo: input.memo ?? null,
  }));

  const offsetLine: RecurringJeLine = {
    account_id: input.offsetAccountId,
    debit_cents: input.allocatedSide === 'debit' ? 0 : total,
    credit_cents: input.allocatedSide === 'debit' ? total : 0,
    location_id: input.offsetLocationId ?? null,
    department_id: input.offsetDepartmentId ?? null,
    class_id: null,
    memo: input.memo ?? null,
  };

  return input.allocatedSide === 'debit' ? [...allocatedLines, offsetLine] : [offsetLine, ...allocatedLines];
}
