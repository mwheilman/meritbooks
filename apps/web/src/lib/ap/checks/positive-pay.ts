/**
 * Positive-pay ISSUE files — PURE (FPB-check-processing §4.3, AC-11).
 *
 * The bank compares every presented check against this file (account, check number,
 * amount, and — for payee positive pay — the payee name) and returns mismatches as
 * exceptions. Voided AND spoiled checks are sent as void records so a stolen or reprinted
 * piece of stock is refused at the window.
 *
 * Formats:
 *   GENERIC_CSV        header + one row per record (I = issue, V = void)
 *   CHASE_STYLE_FIXED  80-column fixed width (account 14 · check 10 · amount 10 cents ·
 *                      MMDDYYYY · void flag · payee 37)
 *   BOFA_STYLE_FIXED   95-column fixed width (account 13 · check 10 · amount 12 cents ·
 *                      YYYYMMDD · issue/void code 2 · payee 50)
 *   CUSTOM_CSV         columns / headers / codes from the account's mapping
 *   CUSTOM_FIXED       start / length / pad per field from the account's mapping
 * The two fixed-width presets follow the common layouts those banks publish; every bank
 * revises its spec, so confirm the columns with the bank's current file spec (the custom
 * mapping adjusts any column without code).
 */

export type PositivePayFormat = 'GENERIC_CSV' | 'CHASE_STYLE_FIXED' | 'BOFA_STYLE_FIXED' | 'CUSTOM_CSV' | 'CUSTOM_FIXED';

export const POSITIVE_PAY_FORMATS: ReadonlyArray<{ value: PositivePayFormat; label: string; help: string }> = [
  { value: 'GENERIC_CSV', label: 'Generic CSV', help: 'Account, routing, check number, issue date, amount, payee, I/V.' },
  { value: 'CHASE_STYLE_FIXED', label: 'Chase-style fixed width (80)', help: 'Common Chase ARP layout. Confirm with your bank.' },
  { value: 'BOFA_STYLE_FIXED', label: 'Bank of America-style fixed width (95)', help: 'Common BofA ARP layout. Confirm with your bank.' },
  { value: 'CUSTOM_CSV', label: 'Custom CSV', help: 'Choose the columns, headers and codes.' },
  { value: 'CUSTOM_FIXED', label: 'Custom fixed width', help: 'Set each field’s start and length.' },
];

export type PpField = 'account' | 'routing' | 'check_number' | 'amount' | 'issue_date' | 'payee' | 'record_code' | 'constant' | 'filler';
export type PpDateFormat = 'MMDDYYYY' | 'YYYYMMDD' | 'MMDDYY' | 'YYYY-MM-DD' | 'MM/DD/YYYY';
export type PpAmountFormat = 'CENTS' | 'DOLLARS';

export interface PositivePayRecord {
  accountNumber: string;
  routingNumber: string;
  checkNumber: number;
  amountCents: number;
  issueDate: string; // YYYY-MM-DD
  payeeName: string;
  voided: boolean;
}

export interface CsvColumn {
  field: PpField;
  header: string;
  /** For field 'constant'. */
  value?: string;
}

export interface CsvMapping {
  columns: CsvColumn[];
  includeHeader: boolean;
  dateFormat: PpDateFormat;
  amountFormat: PpAmountFormat;
  issueCode: string;
  voidCode: string;
  delimiter?: ',' | '|' | '\t';
}

export interface FixedFieldSpec {
  field: PpField;
  /** 1-based start column. */
  start: number;
  length: number;
  align: 'left' | 'right';
  pad: '0' | ' ';
  value?: string;
}

export interface FixedMapping {
  fields: FixedFieldSpec[];
  recordLength: number;
  dateFormat: PpDateFormat;
  amountFormat: PpAmountFormat;
  issueCode: string;
  voidCode: string;
}

export const GENERIC_CSV_MAPPING: CsvMapping = {
  columns: [
    { field: 'account', header: 'Account Number' },
    { field: 'routing', header: 'Routing Number' },
    { field: 'check_number', header: 'Check Number' },
    { field: 'issue_date', header: 'Issue Date' },
    { field: 'amount', header: 'Amount' },
    { field: 'payee', header: 'Payee Name' },
    { field: 'record_code', header: 'Void Indicator' },
  ],
  includeHeader: true,
  dateFormat: 'MM/DD/YYYY',
  amountFormat: 'DOLLARS',
  issueCode: 'I',
  voidCode: 'V',
};

export const CHASE_STYLE_FIXED: FixedMapping = {
  recordLength: 80,
  dateFormat: 'MMDDYYYY',
  amountFormat: 'CENTS',
  issueCode: ' ',
  voidCode: 'V',
  fields: [
    { field: 'account', start: 1, length: 14, align: 'right', pad: '0' },
    { field: 'check_number', start: 15, length: 10, align: 'right', pad: '0' },
    { field: 'amount', start: 25, length: 10, align: 'right', pad: '0' },
    { field: 'issue_date', start: 35, length: 8, align: 'left', pad: ' ' },
    { field: 'record_code', start: 43, length: 1, align: 'left', pad: ' ' },
    { field: 'payee', start: 44, length: 37, align: 'left', pad: ' ' },
  ],
};

export const BOFA_STYLE_FIXED: FixedMapping = {
  recordLength: 95,
  dateFormat: 'YYYYMMDD',
  amountFormat: 'CENTS',
  issueCode: '20',
  voidCode: '26',
  fields: [
    { field: 'account', start: 1, length: 13, align: 'right', pad: '0' },
    { field: 'check_number', start: 14, length: 10, align: 'right', pad: '0' },
    { field: 'amount', start: 24, length: 12, align: 'right', pad: '0' },
    { field: 'issue_date', start: 36, length: 8, align: 'left', pad: ' ' },
    { field: 'record_code', start: 44, length: 2, align: 'left', pad: ' ' },
    { field: 'payee', start: 46, length: 50, align: 'left', pad: ' ' },
  ],
};

export class PositivePayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PositivePayError';
  }
}

export function formatPpDate(iso: string, f: PpDateFormat): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new PositivePayError(`Bad issue date ${iso}`);
  const [, y, mo, d] = m;
  switch (f) {
    case 'MMDDYYYY': return `${mo}${d}${y}`;
    case 'YYYYMMDD': return `${y}${mo}${d}`;
    case 'MMDDYY': return `${mo}${d}${y.slice(2)}`;
    case 'YYYY-MM-DD': return `${y}-${mo}-${d}`;
    case 'MM/DD/YYYY': return `${mo}/${d}/${y}`;
  }
}

export function formatPpAmount(cents: number, f: PpAmountFormat): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new PositivePayError('Bad amount');
  if (f === 'CENTS') return String(cents);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/** Payee text for a bank file: printable ASCII only, single spaces. */
export function cleanPayee(name: string): string {
  return name.normalize('NFKD').replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim();
}

function fieldValue(r: PositivePayRecord, field: PpField, m: { dateFormat: PpDateFormat; amountFormat: PpAmountFormat; issueCode: string; voidCode: string }, constant?: string): string {
  switch (field) {
    case 'account': return r.accountNumber;
    case 'routing': return r.routingNumber;
    case 'check_number': return String(r.checkNumber);
    case 'amount': return formatPpAmount(r.amountCents, m.amountFormat);
    case 'issue_date': return formatPpDate(r.issueDate, m.dateFormat);
    case 'payee': return cleanPayee(r.payeeName);
    case 'record_code': return r.voided ? m.voidCode : m.issueCode;
    case 'constant': return constant ?? '';
    case 'filler': return '';
  }
}

function csvCell(v: string, delim: string): string {
  if (v.includes('"') || v.includes(delim) || /[\r\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

export function toCsv(records: readonly PositivePayRecord[], m: CsvMapping): string {
  const d = m.delimiter ?? ',';
  const lines: string[] = [];
  if (m.includeHeader) lines.push(m.columns.map((c) => csvCell(c.header, d)).join(d));
  for (const r of records) lines.push(m.columns.map((c) => csvCell(fieldValue(r, c.field, m, c.value), d)).join(d));
  return lines.join('\r\n') + '\r\n';
}

function fit(value: string, spec: FixedFieldSpec): string {
  let v = value;
  if (v.length > spec.length) {
    // Numbers that don't fit are an error (truncating them would change the check); text is cut.
    if (spec.field === 'account' || spec.field === 'check_number' || spec.field === 'amount' || spec.field === 'routing') {
      throw new PositivePayError(`The ${spec.field.replace('_', ' ')} "${v}" is longer than its ${spec.length}-character column.`);
    }
    v = v.slice(0, spec.length);
  }
  return spec.align === 'right' ? v.padStart(spec.length, spec.pad) : v.padEnd(spec.length, spec.pad);
}

export function validateFixedMapping(m: FixedMapping): string | null {
  if (!Number.isInteger(m.recordLength) || m.recordLength < 10 || m.recordLength > 1000) return 'Record length must be 10–1000.';
  const taken = new Array<boolean>(m.recordLength + 1).fill(false);
  for (const f of m.fields) {
    if (!Number.isInteger(f.start) || !Number.isInteger(f.length) || f.start < 1 || f.length < 1) return 'Every field needs a start and length of at least 1.';
    if (f.start + f.length - 1 > m.recordLength) return `The ${f.field} field runs past column ${m.recordLength}.`;
    for (let i = f.start; i < f.start + f.length; i++) {
      if (taken[i]) return `Two fields overlap at column ${i}.`;
      taken[i] = true;
    }
  }
  for (const req of ['account', 'check_number', 'amount', 'issue_date'] as const) {
    if (!m.fields.some((f) => f.field === req)) return `The layout needs a ${req.replace('_', ' ')} field.`;
  }
  return null;
}

export function toFixedWidth(records: readonly PositivePayRecord[], m: FixedMapping): string {
  const problem = validateFixedMapping(m);
  if (problem) throw new PositivePayError(problem);
  const sorted = [...m.fields].sort((a, b) => a.start - b.start);
  const lines = records.map((r) => {
    const chars = new Array<string>(m.recordLength).fill(' ');
    for (const f of sorted) {
      const v = fit(fieldValue(r, f.field, m, f.value), f);
      for (let i = 0; i < v.length; i++) chars[f.start - 1 + i] = v[i];
    }
    return chars.join('');
  });
  return lines.join('\r\n') + (lines.length ? '\r\n' : '');
}

export interface PositivePayFile {
  content: string;
  extension: 'csv' | 'txt';
  mime: string;
}

/** Build the file for an account's format (custom formats need their mapping). */
export function buildPositivePayFile(
  records: readonly PositivePayRecord[],
  format: PositivePayFormat,
  mapping?: { csv?: CsvMapping; fixed?: FixedMapping } | null,
): PositivePayFile {
  switch (format) {
    case 'GENERIC_CSV':
      return { content: toCsv(records, GENERIC_CSV_MAPPING), extension: 'csv', mime: 'text/csv' };
    case 'CHASE_STYLE_FIXED':
      return { content: toFixedWidth(records, CHASE_STYLE_FIXED), extension: 'txt', mime: 'text/plain' };
    case 'BOFA_STYLE_FIXED':
      return { content: toFixedWidth(records, BOFA_STYLE_FIXED), extension: 'txt', mime: 'text/plain' };
    case 'CUSTOM_CSV':
      if (!mapping?.csv) throw new PositivePayError('Set up the custom CSV columns on the Check stock tab first.');
      return { content: toCsv(records, mapping.csv), extension: 'csv', mime: 'text/csv' };
    case 'CUSTOM_FIXED':
      if (!mapping?.fixed) throw new PositivePayError('Set up the custom fixed-width layout on the Check stock tab first.');
      return { content: toFixedWidth(records, mapping.fixed), extension: 'txt', mime: 'text/plain' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Which checks go in the next file
// ─────────────────────────────────────────────────────────────────────────────

export interface RegisterCheckForPp {
  id: string;
  checkNumber: number;
  checkDate: string;
  amountCents: number;
  payeeName: string;
  status: 'PRINTED' | 'ISSUED' | 'MAILED' | 'CLEARED' | 'VOIDED' | 'SPOILED';
  voidedAt: string | null;
  issueExportId: string | null;
  voidExportId: string | null;
}

export interface PpSelection {
  issues: RegisterCheckForPp[];
  voids: RegisterCheckForPp[];
}

/**
 * SINCE_LAST: every check not yet sent as an issue (spoiled excluded — it was never issued)
 * plus every voided / spoiled check not yet sent as a void. RANGE: issues dated in
 * [from, through] plus voids voided in it (re-sending is harmless; the stamps record the
 * first file that carried each record).
 */
export function selectForPositivePay(
  checks: readonly RegisterCheckForPp[],
  mode: 'SINCE_LAST' | 'RANGE',
  range?: { from: string; through: string },
): PpSelection {
  const inRange = (d: string | null) => !!d && !!range && d.slice(0, 10) >= range.from && d.slice(0, 10) <= range.through;
  const issues = checks.filter((c) =>
    c.status !== 'SPOILED' && (mode === 'SINCE_LAST' ? c.issueExportId === null : inRange(c.checkDate)));
  const voids = checks.filter((c) =>
    (c.status === 'VOIDED' || c.status === 'SPOILED') && (mode === 'SINCE_LAST' ? c.voidExportId === null : inRange(c.voidedAt)));
  const byNum = (a: RegisterCheckForPp, b: RegisterCheckForPp) => a.checkNumber - b.checkNumber;
  return { issues: [...issues].sort(byNum), voids: [...voids].sort(byNum) };
}

export function toRecords(sel: PpSelection, account: string, routing: string): PositivePayRecord[] {
  const rec = (c: RegisterCheckForPp, voided: boolean): PositivePayRecord => ({
    accountNumber: account,
    routingNumber: routing,
    checkNumber: c.checkNumber,
    amountCents: c.amountCents,
    issueDate: c.checkDate,
    payeeName: c.payeeName,
    voided,
  });
  return [...sel.issues.map((c) => rec(c, false)), ...sel.voids.map((c) => rec(c, true))];
}
