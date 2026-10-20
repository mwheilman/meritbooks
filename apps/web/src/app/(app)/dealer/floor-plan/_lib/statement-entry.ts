/**
 * Manual lender-statement entry: the editable grid ↔ the `lenderStatementImport`
 * body, spreadsheet paste parsing, and a plain-English live footing check built on
 * the D1 pure engine `footStatement` (the same check the server runs). Pure.
 */

import { footStatement, type FootingResult } from '@/lib/dealer/engine/statement-match';
import { money, parseDollarsToCents } from '@/lib/dealer/ui/format';

export interface StatementDraftLine {
  key: string;
  lenderInvoiceNumber: string;
  serialNumber: string;
  model: string;
  originalCents: number | null;
  currentCents: number | null;
  interestCents: number | null;
  feesCents: number | null;
  lenderCode: string;
  dispositionDate: string;
  days: string;
}

export interface StatementApiLine {
  lenderInvoiceNumber: string | null;
  serialNumber: string | null;
  model: string | null;
  originalCents: number | null;
  currentCents: number | null;
  interestCents: number | null;
  feesCents: number | null;
  lenderCode: string | null;
  dispositionDate: string | null;
  days: number | null;
}

export interface FooterDraft {
  principalCents: number | null;
  interestCents: number | null;
  feesCents: number | null;
  lineCount: string;
}

let seq = 0;
export function blankLine(): StatementDraftLine {
  seq += 1;
  return {
    key: `l${Date.now().toString(36)}${seq}`,
    lenderInvoiceNumber: '',
    serialNumber: '',
    model: '',
    originalCents: null,
    currentCents: null,
    interestCents: null,
    feesCents: null,
    lenderCode: '',
    dispositionDate: '',
    days: '',
  };
}

/** A grid row nobody typed into is ignored (not sent, not counted). */
export function isBlank(l: StatementDraftLine): boolean {
  return (
    !l.lenderInvoiceNumber.trim() && !l.serialNumber.trim() && !l.model.trim() && l.originalCents === null && l.currentCents === null &&
    l.interestCents === null && l.feesCents === null && !l.lenderCode.trim() && !l.dispositionDate && !l.days.trim()
  );
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Per-row problems (keyed by row key) — mirrors the Zod field limits. */
export function validateLines(lines: StatementDraftLine[]): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const l of lines) {
    if (isBlank(l)) continue;
    if (!l.lenderInvoiceNumber.trim() && !l.serialNumber.trim() && !l.model.trim()) {
      errors[l.key] = 'Give the lender invoice #, serial or model so the line can be matched.';
    } else if (l.lenderInvoiceNumber.length > 100 || l.serialNumber.length > 100) {
      errors[l.key] = 'Invoice # and serial must be 100 characters or fewer.';
    } else if (l.model.length > 200) {
      errors[l.key] = 'Model must be 200 characters or fewer.';
    } else if (l.lenderCode.trim().length > 20) {
      errors[l.key] = 'The lender code must be 20 characters or fewer.';
    } else if (l.dispositionDate && !ISO.test(l.dispositionDate)) {
      errors[l.key] = 'Use a full disposition date.';
    } else if (l.days.trim() && !/^\d{1,6}$/.test(l.days.trim())) {
      errors[l.key] = 'Days must be a whole number.';
    } else if ([l.originalCents, l.currentCents, l.interestCents, l.feesCents].some((c) => c !== null && c < 0)) {
      errors[l.key] = 'Amounts can’t be negative.';
    }
  }
  return errors;
}

export function toApiLines(lines: StatementDraftLine[]): StatementApiLine[] {
  return lines.filter((l) => !isBlank(l)).map((l) => ({
    lenderInvoiceNumber: l.lenderInvoiceNumber.trim() || null,
    serialNumber: l.serialNumber.trim() || null,
    model: l.model.trim() || null,
    originalCents: l.originalCents,
    currentCents: l.currentCents,
    interestCents: l.interestCents,
    feesCents: l.feesCents,
    lenderCode: l.lenderCode.trim().toUpperCase() || null,
    dispositionDate: l.dispositionDate || null,
    days: l.days.trim() ? Number(l.days.trim()) : null,
  }));
}

export interface FootingRow {
  label: string;
  linesTotal: string;
  footer: string;
  ok: boolean | null;
}

export interface FootingView {
  ok: boolean;
  rows: FootingRow[];
  result: FootingResult;
}

/** Live footing check in plain English (dollars, not cents). */
export function checkFooting(lines: StatementDraftLine[], footer: FooterDraft): FootingView {
  const api = toApiLines(lines);
  const lineCount = footer.lineCount.trim() === '' ? null : /^\d+$/.test(footer.lineCount.trim()) ? Number(footer.lineCount.trim()) : NaN;
  const result = footStatement(
    api.map((l) => ({
      lender_invoice_number: l.lenderInvoiceNumber,
      serial_number: l.serialNumber,
      model: l.model,
      original_cents: l.originalCents,
      current_cents: l.currentCents,
      interest_cents: l.interestCents,
      fees_cents: l.feesCents,
      lender_code: l.lenderCode,
    })),
    {
      principalCents: footer.principalCents,
      interestCents: footer.interestCents,
      feesCents: footer.feesCents,
      lineCount: Number.isNaN(lineCount) ? null : lineCount,
    },
  );
  const s = result.sums;
  const rows: FootingRow[] = [
    {
      label: 'Principal (current balance)',
      linesTotal: money(s.principalCents),
      footer: footer.principalCents === null ? 'Required' : money(footer.principalCents),
      ok: footer.principalCents === null ? false : footer.principalCents === s.principalCents,
    },
    {
      label: 'Interest',
      linesTotal: money(s.interestCents),
      footer: footer.interestCents === null ? 'Not given' : money(footer.interestCents),
      ok: footer.interestCents === null ? null : footer.interestCents === s.interestCents,
    },
    {
      label: 'Fees',
      linesTotal: money(s.feesCents),
      footer: footer.feesCents === null ? 'Not given' : money(footer.feesCents),
      ok: footer.feesCents === null ? null : footer.feesCents === s.feesCents,
    },
    {
      label: 'Number of lines',
      linesTotal: String(s.lineCount),
      footer: lineCount === null ? 'Not given' : Number.isNaN(lineCount) ? 'Not a number' : String(lineCount),
      ok: lineCount === null ? null : Number.isNaN(lineCount) ? false : lineCount === s.lineCount,
    },
  ];
  const countOk = !Number.isNaN(lineCount);
  return { ok: result.ok && countOk, rows, result };
}

/**
 * Parse rows pasted from a spreadsheet (tab-separated; commas accepted when there
 * are no tabs). Column order matches the grid: invoice #, serial, model, original,
 * current, interest, fees, code, disposition date, days. A header row (no money in
 * the original/current columns and a non-numeric first cell) is skipped.
 */
export function parsePastedLines(text: string): { lines: StatementDraftLine[]; skipped: number } {
  const out: StatementDraftLine[] = [];
  let skipped = 0;
  const rows = text.replace(/\r\n?/g, '\n').split('\n').filter((r) => r.trim() !== '');
  rows.forEach((raw, i) => {
    const cells = (raw.includes('\t') ? raw.split('\t') : raw.split(',')).map((c) => c.trim());
    const cell = (n: number) => cells[n] ?? '';
    const amt = (n: number): number | null | 'bad' => {
      const c = cell(n).replace(/[()]/g, '');
      if (c === '') return null;
      const v = parseDollarsToCents(c);
      return v === null ? 'bad' : v;
    };
    const original = amt(3);
    const current = amt(4);
    const interest = amt(5);
    const fees = amt(6);
    if (i === 0 && (original === 'bad' || current === 'bad')) {
      skipped += 1; // header row
      return;
    }
    if ([original, current, interest, fees].includes('bad')) {
      skipped += 1;
      return;
    }
    const date = normalizeDate(cell(8));
    const line: StatementDraftLine = {
      ...blankLine(),
      lenderInvoiceNumber: cell(0),
      serialNumber: cell(1),
      model: cell(2),
      originalCents: original as number | null,
      currentCents: current as number | null,
      interestCents: interest as number | null,
      feesCents: fees as number | null,
      lenderCode: cell(7),
      dispositionDate: date ?? '',
      days: /^\d+$/.test(cell(9)) ? cell(9) : '',
    };
    if (isBlank(line)) skipped += 1;
    else out.push(line);
  });
  return { lines: out, skipped };
}

/** "2026-09-30" | "9/30/2026" | "09/30/26" → ISO; null when not a date. */
export function normalizeDate(s: string): string | null {
  const t = s.trim();
  if (!t) return null;
  if (ISO.test(t)) return t;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(t);
  if (!m) return null;
  const yy = m[3].length === 2 ? `20${m[3]}` : m[3];
  const mm = Number(m[1]);
  const dd = Number(m[2]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}
