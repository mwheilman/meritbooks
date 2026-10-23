/**
 * Check register helpers — PURE (FPB-check-processing §4.2, AC-13).
 */

export type CheckStatus = 'PRINTED' | 'ISSUED' | 'MAILED' | 'CLEARED' | 'VOIDED' | 'SPOILED';
export const OUTSTANDING_STATUSES: ReadonlyArray<CheckStatus> = ['PRINTED', 'ISSUED', 'MAILED'];
export const TERMINAL_STATUSES: ReadonlyArray<CheckStatus> = ['VOIDED', 'SPOILED'];

export const STATUS_LABEL: Readonly<Record<CheckStatus, string>> = {
  PRINTED: 'Printed',
  ISSUED: 'Issued',
  MAILED: 'Mailed',
  CLEARED: 'Cleared',
  VOIDED: 'Voided',
  SPOILED: 'Spoiled',
};

export function isOutstanding(status: CheckStatus): boolean {
  return OUTSTANDING_STATUSES.includes(status);
}

/** Whole days from `from` (YYYY-MM-DD) to `to`. */
export function daysBetween(from: string, to: string): number {
  const a = Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)));
  const b = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)));
  return Math.floor((b - a) / 86_400_000);
}

/** Outstanding longer than the account's stale threshold (default 180 days). */
export function isStale(status: CheckStatus, checkDate: string, today: string, staleAfterDays = 180): boolean {
  return isOutstanding(status) && daysBetween(checkDate, today) > staleAfterDays;
}

/** Past the printed "void after N days" (the bank may refuse it) but not yet stale. */
export function isPastVoidDate(status: CheckStatus, checkDate: string, today: string, voidAfterDays = 90): boolean {
  return isOutstanding(status) && daysBetween(checkDate, today) > voidAfterDays;
}

export interface DeclaredSkip {
  fromNumber: number;
  toNumber: number;
}

/**
 * Numbers missing between the lowest and highest issued number, minus ranges the sequence
 * declared as skipped (a move from 1050 to 1100 declares 1050–1099). Capped so a huge
 * declared jump can't blow up the response.
 */
export function findGaps(numbers: readonly number[], skips: readonly DeclaredSkip[] = [], cap = 200): { missing: number[]; truncated: boolean } {
  if (numbers.length < 2) return { missing: [], truncated: false };
  const used = new Set(numbers);
  const min = Math.min(...numbers);
  const max = Math.max(...numbers);
  const declared = (n: number) => skips.some((s) => s.toNumber > s.fromNumber && n >= s.fromNumber && n < s.toNumber);
  const missing: number[] = [];
  for (let n = min + 1; n < max; n++) {
    if (used.has(n) || declared(n)) continue;
    missing.push(n);
    if (missing.length >= cap) return { missing, truncated: true };
  }
  return { missing, truncated: false };
}

/** Collapse [1017, 1018, 1019, 1030] → "1017–1019, 1030". */
export function formatRanges(nums: readonly number[]): string {
  if (nums.length === 0) return '';
  const sorted = [...nums].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const n = sorted[i];
    if (n === prev + 1) { prev = n; continue; }
    parts.push(start === prev ? String(start) : `${start}–${prev}`);
    start = n;
    prev = n;
  }
  return parts.join(', ');
}

/**
 * The check number a bank line refers to: an explicit check_number column first, else
 * the description ("CHECK 1043", "CHK #1043", "Check No. 1043", "CHECK PAID 0001043").
 */
export function parseCheckNumber(description: string | null | undefined, column?: string | number | null): number | null {
  if (column != null && String(column).trim() !== '') {
    const n = Number(String(column).replace(/\D/g, ''));
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  if (!description) return null;
  const m = /\b(?:CHECK|CHK|CHEQUE|CK)\s*(?:PAID|NO\.?|NUMBER|NUM|#)?\s*#?\s*(\d{1,10})\b/i.exec(description);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** CSV cell for a spreadsheet export: quoted when needed, and formula-looking text neutralised. */
export function csvEscape(v: string | number | null | undefined): string {
  let s = v == null ? '' : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
