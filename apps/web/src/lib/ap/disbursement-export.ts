/**
 * AP disbursement EXPORT (money-out MVP, task #109) — PURE, DB-free.
 *
 * Turns a built DisbursementBatch into a FILE the human uploads to their bank.
 * This is the ONLY "payment" output of the money-out MVP: a file, never an API
 * call. Nothing here moves money, posts to the GL, or contacts a bank.
 *
 * Two formats:
 *   1. Bill-pay / positive-pay CSV — the reliable primary output. The bank's
 *      bill-pay portal already holds each payee's banking detail, so the CSV only
 *      needs remittance identity + amount. Always fully populated from owned data.
 *   2. NACHA (ACH) — a standards-SHAPED PPD/CCD file (94-char fixed records,
 *      blocked to 10). NOTE: MeritBooks stores only MASKED bank details
 *      (ach_authorizations keeps last-4 + routing mask, never full numbers), so
 *      unless full routing/account are supplied per vendor the entry-detail bank
 *      fields are PLACEHOLDERS and the result carries a loud warning. Treat the
 *      NACHA output as a template to complete with the bank's real payee records,
 *      or prefer the CSV bill-pay path.
 *
 * All money is bigint cents.
 */

import type { DisbursementBatch, DisbursementItem } from './disbursement-batch';

// ─────────────────────────────────────────────────────────────────────────────
// CSV bill-pay / positive-pay
// ─────────────────────────────────────────────────────────────────────────────

export interface RemittanceDetail {
  vendorId: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  email: string | null;
}

function csvCell(v: string | null | undefined): string {
  const s = v == null ? '' : String(v);
  // Quote if it contains a comma, quote, or newline; escape embedded quotes.
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function dollars(cents: number): string {
  // 2-decimal fixed string from integer cents (no float drift on the integer).
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

const CSV_HEADER = [
  'Payment Date',
  'Vendor Name',
  'Vendor ID',
  'Method',
  'Invoice Number',
  'Amount',
  'Remit Address 1',
  'Remit Address 2',
  'City',
  'State',
  'Zip',
  'Email',
] as const;

/**
 * Bill-pay CSV: one row per disbursement line, grouped by vendor (batch order).
 * Remittance columns are best-effort from the vendor master; missing values are
 * blank. Amounts are decimal dollars derived from integer cents.
 */
export function toBillPayCsv(
  batch: DisbursementBatch,
  remittanceByVendor: Map<string, RemittanceDetail>,
): string {
  const rows: string[] = [CSV_HEADER.map(csvCell).join(',')];
  for (const group of batch.groups) {
    for (const item of group.items) {
      const r = remittanceByVendor.get(item.vendorId);
      rows.push(
        [
          item.paymentDate,
          item.vendorName,
          item.vendorId,
          item.method,
          item.invoiceRef ?? '',
          dollars(item.amountCents),
          r?.addressLine1 ?? '',
          r?.addressLine2 ?? '',
          r?.city ?? '',
          r?.state ?? '',
          r?.zip ?? '',
          r?.email ?? '',
        ]
          .map(csvCell)
          .join(','),
      );
    }
  }
  // Trailing control row so the operator can eyeball the batch total.
  rows.push(
    [
      'TOTAL',
      `${batch.controls.itemCount} payments`,
      '',
      '',
      '',
      dollars(batch.controls.totalCents),
      '',
      '',
      '',
      '',
      '',
      '',
    ]
      .map(csvCell)
      .join(','),
  );
  return rows.join('\r\n') + '\r\n';
}

// ─────────────────────────────────────────────────────────────────────────────
// NACHA (ACH) — standards-shaped PPD/CCD, 94-char fixed records
// ─────────────────────────────────────────────────────────────────────────────

export interface NachaConfig {
  /** ODFI (your bank's) routing transit number, 9 digits. */
  immediateDestination: string;
  /** your company/originating id (often the EIN with a leading 1), up to 10. */
  immediateOrigin: string;
  destinationName: string; // your bank's name
  originName: string; // your company name
  companyName: string; // appears in the batch header (<=16)
  companyId: string; // usually '1' + EIN, 10 chars
  /** SEC code — CCD for business-to-business, PPD for consumer. Default CCD. */
  secCode?: 'CCD' | 'PPD';
  companyEntryDescription?: string; // e.g. 'AP PAYMT' (<=10)
  /** ISO date the entries settle (effective entry date). */
  effectiveDate: string;
  fileIdModifier?: string; // single char, default 'A'
  /** deterministic clock for the file/creation timestamp (tests pass a fixed one). */
  now?: Date;
}

/** Full banking instruction for one vendor (NOT stored by MeritBooks — supplied). */
export interface NachaVendorInstruction {
  vendorId: string;
  routingNumber?: string | null; // 9 digits (8 + check)
  accountNumber?: string | null;
  accountType?: 'checking' | 'savings';
}

export interface NachaResult {
  text: string;
  warnings: string[];
  entryCount: number;
  totalCents: number;
}

const REC_LEN = 94;

function padRight(s: string, n: number): string {
  return (s ?? '').slice(0, n).padEnd(n, ' ');
}
function padLeftNum(s: string, n: number): string {
  const digits = (s ?? '').replace(/\D/g, '');
  return digits.slice(-n).padStart(n, '0');
}
function rec(s: string): string {
  if (s.length !== REC_LEN) {
    throw new Error(`NACHA record must be ${REC_LEN} chars, got ${s.length}: "${s}"`);
  }
  return s;
}
function yymmdd(d: Date): string {
  const yy = String(d.getUTCFullYear()).slice(-2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}
function hhmm(d: Date): string {
  return `${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
function isoToYymmdd(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '000000';
  return yymmdd(d);
}

/**
 * Build a standards-shaped NACHA ACH credit file for the batch (ACH lines only —
 * CHECK lines are excluded and reported in `warnings`). The receiving-bank fields
 * are filled from `instructionsByVendor` where present; otherwise placeholders are
 * emitted and a warning is raised (MeritBooks holds only masked bank details).
 */
export function buildNachaFile(
  batch: DisbursementBatch,
  config: NachaConfig,
  instructionsByVendor: Map<string, NachaVendorInstruction>,
): NachaResult {
  const warnings: string[] = [];
  const now = config.now ?? new Date();
  const sec = config.secCode ?? 'CCD';
  const entryDescription = (config.companyEntryDescription ?? 'AP PAYMT').toUpperCase();
  const fileIdModifier = (config.fileIdModifier ?? 'A').slice(0, 1);
  const odfiEight = padLeftNum(config.immediateDestination, 9).slice(0, 8); // routing first 8

  // Collect ACH entry lines from the batch (skip CHECK-method lines).
  const achItems: DisbursementItem[] = [];
  let checkSkipped = 0;
  for (const g of batch.groups) {
    for (const it of g.items) {
      if (it.method === 'ACH') achItems.push(it);
      else checkSkipped += 1;
    }
  }
  if (checkSkipped > 0) {
    warnings.push(`${checkSkipped} CHECK-method line(s) excluded from the ACH file — pay those by check/positive-pay.`);
  }

  const lines: string[] = [];

  // 1 — File Header
  lines.push(
    rec(
      '1' +
        '01' +
        ' ' + padLeftNum(config.immediateDestination, 9) + // 10: leading space + 9
        padRight(config.immediateOrigin, 10) +
        yymmdd(now) +
        hhmm(now) +
        fileIdModifier +
        '094' +
        '10' +
        '1' +
        padRight(config.destinationName, 23) +
        padRight(config.originName, 23) +
        padRight('', 8),
    ),
  );

  // 5 — Batch Header (service class 220 = credits only)
  const batchNumber = '0000001';
  lines.push(
    rec(
      '5' +
        '220' +
        padRight(config.companyName, 16) +
        padRight('', 20) +
        padRight(config.companyId, 10) +
        sec +
        padRight(entryDescription, 10) +
        yymmdd(now).slice(0, 6) + // descriptive date
        isoToYymmdd(config.effectiveDate) +
        padRight('', 3) + // settlement date (bank-filled)
        '1' + // originator status code
        odfiEight +
        batchNumber,
    ),
  );

  // 6 — Entry Detail (one per ACH line)
  let entryHash = 0;
  let totalCredit = 0;
  let seq = 0;
  let missingBankDetail = 0;
  for (const it of achItems) {
    seq += 1;
    const instr = instructionsByVendor.get(it.vendorId);
    const routing9 = instr?.routingNumber ? padLeftNum(instr.routingNumber, 9) : '';
    const rdfiEight = routing9 ? routing9.slice(0, 8) : '00000000';
    const checkDigit = routing9 ? routing9.slice(8, 9) : '0';
    const account = instr?.accountNumber ? instr.accountNumber.replace(/\s/g, '') : '';
    if (!instr?.routingNumber || !instr?.accountNumber) missingBankDetail += 1;
    // 22 = checking credit, 32 = savings credit
    const txnCode = instr?.accountType === 'savings' ? '32' : '22';
    entryHash += Number(rdfiEight) || 0;
    totalCredit += it.amountCents;
    const traceNumber = odfiEight + String(seq).padStart(7, '0');
    lines.push(
      rec(
        '6' +
          txnCode +
          rdfiEight +
          checkDigit +
          padRight(account, 17) +
          padLeftNum(String(it.amountCents), 10) +
          padRight(it.billId.replace(/-/g, '').slice(0, 15), 15) + // individual id number
          padRight(it.vendorName.toUpperCase(), 22) +
          padRight('', 2) + // discretionary data
          '0' + // addenda record indicator
          traceNumber,
      ),
    );
  }
  if (missingBankDetail > 0) {
    warnings.push(
      `${missingBankDetail} of ${achItems.length} ACH entr${achItems.length === 1 ? 'y' : 'ies'} have PLACEHOLDER routing/account — MeritBooks stores only masked bank details. Complete these with the bank's payee records before uploading, or use the bill-pay CSV.`,
    );
  }

  // 8 — Batch Control
  const entryAddendaCount = achItems.length;
  const hashTrunc = padLeftNum(String(entryHash), 10);
  lines.push(
    rec(
      '8' +
        '220' +
        String(entryAddendaCount).padStart(6, '0') +
        hashTrunc +
        '000000000000' + // total debit (12) — none for a credits-only file
        padLeftNum(String(totalCredit), 12) +
        padRight(config.companyId, 10) +
        padRight('', 19) + // message authentication code
        padRight('', 6) + // reserved
        odfiEight +
        batchNumber,
    ),
  );

  // 9 — File Control (block count includes the 9-filler padding computed below)
  const recordsBeforePad = lines.length + 1; // + this file-control record
  const blockCount = Math.ceil(recordsBeforePad / 10);
  lines.push(
    rec(
      '9' +
        '000001' + // batch count
        String(blockCount).padStart(6, '0') +
        String(entryAddendaCount).padStart(8, '0') +
        hashTrunc +
        '000000000000' +
        padLeftNum(String(totalCredit), 12) +
        padRight('', 39),
    ),
  );

  // 9-filler rows to block to a multiple of 10.
  while (lines.length % 10 !== 0) {
    lines.push('9'.repeat(REC_LEN));
  }

  return {
    text: lines.join('\n') + '\n',
    warnings,
    entryCount: entryAddendaCount,
    totalCents: totalCredit,
  };
}
