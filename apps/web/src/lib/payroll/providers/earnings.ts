/**
 * Earnings hand-off helpers shared by every payroll adapter — validation of the
 * earnings lines Books asks payroll to pay (commissions, bonuses, spiffs) and the
 * provider-neutral EARNINGS CSV that lets ANY payroll system import them.
 *
 * PURE: no I/O, no clock. Money is integer cents; dollars are produced only at the
 * file boundary with integer arithmetic.
 */

import {
  centsToDecimal,
  type EarningsLine,
  type EarningsLineRejection,
  type ExternalEarningType,
  type ImportEarningsInput,
  type RenderedFile,
} from './types';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Split lines into valid / rejected. Rejects: non-integer or non-positive cents,
 * blank employee, blank sourceRef, and DUPLICATE sourceRefs within the batch (the
 * idempotency key — paying the same statement twice is the failure we guard).
 */
export function validateEarningsLines(lines: EarningsLine[]): {
  valid: EarningsLine[];
  rejected: EarningsLineRejection[];
} {
  const valid: EarningsLine[] = [];
  const rejected: EarningsLineRejection[] = [];
  const seen = new Set<string>();
  lines.forEach((l, index) => {
    const ref = (l.sourceRef ?? '').trim();
    const reject = (reason: string) => rejected.push({ index, sourceRef: ref, reason });
    if (!ref) return reject('missing sourceRef');
    if (seen.has(ref)) return reject('duplicate sourceRef in batch');
    if (!(l.employeeId ?? '').trim()) return reject('missing employeeId');
    if (!Number.isInteger(l.amountCents)) return reject('amountCents must be an integer');
    if (l.amountCents <= 0) return reject('amountCents must be positive (clawbacks are netted before hand-off)');
    seen.add(ref);
    valid.push(l);
  });
  return { valid, rejected };
}

/** Default, provider-neutral column headers for the earnings CSV. */
export const EARNINGS_CSV_COLUMNS = [
  'employee_id',
  'provider_employee_id',
  'employee_name',
  'earning_type',
  'amount',
  'pay_date',
  'period_start',
  'period_end',
  'memo',
  'source_ref',
] as const;

export type EarningsCsvColumn = (typeof EARNINGS_CSV_COLUMNS)[number];

/** Provider-facing earning-type labels (overridable per tenant mapping). */
export const DEFAULT_EARNING_TYPE_LABELS: Record<ExternalEarningType, string> = {
  COMMISSION: 'Commission',
  BONUS: 'Bonus',
  SPIFF: 'Bonus',
  REIMBURSEMENT: 'Reimbursement',
  OTHER: 'Other Earnings',
};

export interface EarningsCsvOptions {
  /** Rename columns to match the target system's import template. */
  headerOverrides?: Partial<Record<EarningsCsvColumn, string>>;
  /** Map earning types to the target system's earning codes. */
  earningTypeLabels?: Partial<Record<ExternalEarningType, string>>;
  /** Filename stem (defaults to "earnings"). */
  filenameStem?: string;
}

/**
 * Quote a CSV cell (RFC 4180) and neutralize spreadsheet formula injection: a
 * cell whose first non-blank character is = + - @ (or that starts with tab / CR)
 * is prefixed with an apostrophe. Leading spaces don't defuse a formula — Excel
 * and Sheets trim them — so `  =HYPERLINK(...)` is caught too.
 * Numeric amount cells are passed through `raw` and never prefixed.
 */
function cell(value: string, raw = false): string {
  let v = value;
  if (!raw && /^[\s]*[=+\-@]|^[\t\r]/.test(v)) v = `'${v}`;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Render the provider-neutral earnings CSV for a validated batch. */
export function renderEarningsCsv(
  input: Pick<ImportEarningsInput, 'payDate' | 'periodStart' | 'periodEnd'>,
  lines: EarningsLine[],
  opts: EarningsCsvOptions = {},
): RenderedFile {
  for (const d of [input.payDate, input.periodStart, input.periodEnd]) {
    if (!ISO_DATE.test(d)) throw new RangeError(`Invalid ISO date in earnings export: ${d}`);
  }
  const labels = { ...DEFAULT_EARNING_TYPE_LABELS, ...(opts.earningTypeLabels ?? {}) };
  const header = EARNINGS_CSV_COLUMNS.map((c) => cell(opts.headerOverrides?.[c] ?? c)).join(',');
  const rows = lines.map((l) =>
    [
      cell(l.employeeId),
      cell(l.providerEmployeeId ?? ''),
      cell(l.employeeName),
      cell(labels[l.earningType]),
      cell(centsToDecimal(l.amountCents), true),
      cell(input.payDate),
      cell(input.periodStart),
      cell(input.periodEnd),
      cell(l.memo ?? ''),
      cell(l.sourceRef),
    ].join(','),
  );
  const stem = (opts.filenameStem ?? 'earnings').replace(/[^a-zA-Z0-9_-]/g, '-');
  return {
    filename: `${stem}-${input.payDate}.csv`,
    contentType: 'text/csv; charset=utf-8',
    content: [header, ...rows].join('\r\n') + '\r\n',
  };
}
