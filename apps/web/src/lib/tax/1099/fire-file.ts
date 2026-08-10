/**
 * IRS FIRE electronic-filing file for Form 1099-NEC (IRS Publication 1220 layout).
 *
 * This is the fixed-width, 750-position-per-record transmittal that the IRS FIRE
 * (Filing Information Returns Electronically) system ingests. It is a strict
 * *superset* of what the filing-service import CSV carries (see form-1099.ts):
 * the same READY records, re-serialized into the T/A/B/C/F record structure the
 * IRS itself parses.
 *
 * PURITY & SAFETY:
 *   - Pure function of its inputs — no I/O, no clock, no randomness — so the same
 *     batch renders identical bytes and is unit-tested without a DB (fire-file.test.ts).
 *   - FILE ONLY. This module builds a downloadable artifact. It NEVER contacts the
 *     IRS, never transmits, never moves money. A human uploads the file to FIRE.
 *   - Money is bigint-safe integer cents throughout. The FIRE amount format is
 *     dollars-and-cents with the decimal point removed (e.g. $600.00 -> "60000"),
 *     which is exactly the integer-cents value — so amounts are emitted with a plain
 *     right-justified, zero-filled `padStart`, never via float arithmetic.
 *   - Required-but-unconfigured fields (Transmitter Control Code, transmitter/payer
 *     TIN) DEGRADE SAFE: a visible placeholder is emitted and a loud WARNING is
 *     returned rather than a silently-invalid file. The caller surfaces the warnings
 *     and the file is explicitly marked NOT transmittable until they are cleared.
 *
 * Reference: IRS Pub. 1220 (Tax Year 2024/2025), record layouts for the T (Transmitter),
 * A (Payer), B (Payee), C (End of Payer), and F (End of Transmission) records.
 */

import type { Form1099Batch } from '../form-1099';
import { normalizeTin } from '../form-1099';

/** Every FIRE record is exactly 750 positions wide. */
export const FIRE_RECORD_LENGTH = 750;

/** 1099-NEC "Type of Return" code (A record, positions 26-27). */
export const NEC_TYPE_OF_RETURN = 'NE';

/** Placeholder emitted when the real value is unconfigured (with a warning). */
export const TCC_PLACEHOLDER = '00000';

/** The transmitter — the entity FIRE recognizes as sending the file (often = payer). */
export interface FireTransmitter {
  /** IRS-assigned 5-char Transmitter Control Code. Required by FIRE; placeholder if absent. */
  tcc: string | null;
  /** Transmitter TIN (9 digits). Defaults to the payer EIN when omitted. */
  tin: string | null;
  name: string | null;
  /** Company (mailing) name — defaults to transmitter name. */
  companyName?: string | null;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  /** When true, position 28 of the T record is "T" (an IRS *test* submission). */
  testFile?: boolean;
}

export interface BuildFireOptions {
  taxYear: number;
  transmitter: FireTransmitter;
}

export interface FireFileResult {
  /** The complete fixed-width file (CRLF-terminated records). */
  content: string;
  /** Loud, human-readable blockers/notes. Non-empty ⇒ review before uploading to FIRE. */
  warnings: string[];
  /** Total records written (T + A + B×n + C + F). */
  recordCount: number;
  /** Number of B (payee) records = READY 1099-NEC recipients. */
  payeeCount: number;
  /** True when a required field was missing and a placeholder was emitted. */
  hasPlaceholders: boolean;
}

// ── Fixed-width primitives ──────────────────────────────────────────────────────

/**
 * A blank 750-position record as a mutable char array.
 * Exported (additive) so the sibling 1099-MISC FIRE builder reuses the exact same
 * fixed-width primitives — no behavior change to the NEC path.
 */
export function blankRecord(): string[] {
  return new Array<string>(FIRE_RECORD_LENGTH).fill(' ');
}

/**
 * Write `value` into `rec` at 1-based `start` for `len` positions. Values longer
 * than `len` are truncated; the caller pre-formats (pad/justify) to exactly `len`.
 */
export function put(rec: string[], start: number, len: number, value: string): void {
  for (let i = 0; i < len; i++) {
    rec[start - 1 + i] = value[i] ?? ' ';
  }
}

/** Alpha field: uppercase, left-justified, space-filled, truncated to `len`. */
export function alpha(value: string | null | undefined, len: number): string {
  return (value ?? '').toString().toUpperCase().slice(0, len).padEnd(len, ' ');
}

/** Numeric field: digits only, right-justified, ZERO-filled, truncated to `len`. */
export function numeric(value: number | string | null | undefined, len: number): string {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.slice(Math.max(0, digits.length - len)).padStart(len, '0');
}

/**
 * Money field: integer cents -> right-justified, zero-filled digits. The FIRE
 * "dollars and cents, no decimal" format is exactly the cents integer. Negative
 * amounts are not permitted on an information return, so they are floored at 0.
 */
export function money(cents: number, len: number): string {
  const n = Math.max(0, Math.trunc(Number(cents) || 0));
  return String(n).padStart(len, '0').slice(-len);
}

/**
 * Name control: first 4 alphanumeric characters of a name, uppercased. Best-effort
 * (the IRS derives its own from the SSA/EIN record); an incorrect control is not
 * fatal to processing, so this is emitted with an informational note, not blocked.
 */
export function nameControl(name: string | null | undefined): string {
  const alnum = (name ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return alnum.slice(0, 4).padEnd(4, ' ');
}

// ── Record builders ─────────────────────────────────────────────────────────────

/** Set the shared Record Sequence Number (positions 500-507, 1-based). */
export function putSeq(rec: string[], seq: number): void {
  put(rec, 500, 8, numeric(seq, 8));
}

function buildTRecord(o: BuildFireOptions, payeeCount: number, seq: number): string[] {
  const t = o.transmitter;
  const rec = blankRecord();
  put(rec, 1, 1, 'T');
  put(rec, 2, 4, numeric(o.taxYear, 4));
  // 6: prior-year indicator (blank = current year)
  put(rec, 7, 9, numeric(t.tin, 9));
  put(rec, 16, 5, alpha(t.tcc && t.tcc.trim() ? t.tcc : TCC_PLACEHOLDER, 5));
  // 28: test-file indicator
  if (t.testFile) put(rec, 28, 1, 'T');
  put(rec, 30, 40, alpha(t.name, 40));
  // 70-109: transmitter name continuation (blank)
  put(rec, 110, 40, alpha(t.companyName ?? t.name, 40));
  put(rec, 190, 40, alpha(t.addressLine1, 40));
  put(rec, 230, 40, alpha(t.city, 40));
  put(rec, 270, 2, alpha(t.state, 2));
  put(rec, 272, 9, numeric(t.zip, 9));
  put(rec, 296, 8, numeric(payeeCount, 8));
  put(rec, 304, 40, alpha(t.contactName, 40));
  put(rec, 344, 15, alpha(t.contactPhone, 15));
  put(rec, 359, 50, alpha(t.contactEmail, 50));
  putSeq(rec, seq);
  put(rec, 518, 1, 'I'); // Vendor indicator: "I" = in-house software
  return rec;
}

function buildARecord(
  batch: Form1099Batch,
  taxYear: number,
  amountCodes: string,
  seq: number,
): string[] {
  const p = batch.payer;
  const rec = blankRecord();
  put(rec, 1, 1, 'A');
  put(rec, 2, 4, numeric(taxYear, 4));
  // 6: combined federal/state filer (blank = not participating)
  put(rec, 12, 9, numeric(p.tin, 9));
  put(rec, 21, 4, nameControl(p.name)); // payer name control (optional)
  put(rec, 26, 2, NEC_TYPE_OF_RETURN);
  put(rec, 28, 16, amountCodes.padEnd(16, ' ')); // amount codes, left-justified
  // 52: foreign-entity indicator (blank)
  put(rec, 53, 40, alpha(p.name, 40));
  // 93-132: second payer name line (blank)
  put(rec, 133, 1, '0'); // transfer-agent indicator: 0 = payer is the filer
  put(rec, 134, 40, alpha(p.addressLine1, 40));
  put(rec, 174, 40, alpha(p.city, 40));
  put(rec, 214, 2, alpha(p.state, 2));
  put(rec, 216, 9, numeric(p.zip, 9));
  put(rec, 225, 15, alpha(p.phone, 15));
  putSeq(rec, seq);
  return rec;
}

/** B (payee) record — Payment Amount 1 = Box 1 NEC, Payment Amount 4 = Box 4 fed w/h. */
function buildBRecord(
  r: Form1099Batch['records'][number],
  taxYear: number,
  seq: number,
): string[] {
  const rec = blankRecord();
  put(rec, 1, 1, 'B');
  put(rec, 2, 4, numeric(taxYear, 4));
  // 6: corrected-return indicator (blank = original)
  put(rec, 7, 4, nameControl(r.recipientName));
  // 11: type of TIN (blank = not determinable; EIN/SSN unknown from vendor record)
  put(rec, 12, 9, numeric(r.recipientTin, 9));
  // 21-40: payer's account number for payee (vendorId, keeps records unique)
  put(rec, 21, 20, alpha(r.vendorId.replace(/-/g, ''), 20));
  // Payment amounts: field 1 at 55, each 12 wide (1..9 then A..G).
  put(rec, 55, 12, money(r.box1NonemployeeCompCents, 12)); // Amount 1 = Box 1 NEC
  put(rec, 91, 12, money(r.box4FederalTaxWithheldCents, 12)); // Amount 4 = Box 4 fed w/h
  // 247: foreign-country indicator (blank)
  put(rec, 248, 40, alpha(r.recipientName, 40));
  // 288-327: second payee name line (blank)
  put(rec, 368, 40, alpha(r.address.line1, 40));
  put(rec, 448, 40, alpha(r.address.city, 40));
  put(rec, 488, 2, alpha(r.address.state, 2));
  put(rec, 490, 9, numeric(r.address.zip, 9));
  putSeq(rec, seq);
  return rec;
}

/** C (End of Payer) record — payee count + control totals per amount code. */
function buildCRecord(
  batch: Form1099Batch,
  totalBox1Cents: number,
  totalBox4Cents: number,
  seq: number,
): string[] {
  const rec = blankRecord();
  put(rec, 1, 1, 'C');
  put(rec, 2, 8, numeric(batch.records.length, 8));
  // Control totals: 18 positions each; CT n starts at 16 + (n-1)*18.
  // CT1 (amount code 1 = Box 1 NEC) at 16-33; CT4 (code 4 = fed w/h) at 70-87.
  put(rec, 16, 18, money(totalBox1Cents, 18));
  put(rec, 70, 18, money(totalBox4Cents, 18));
  putSeq(rec, seq);
  return rec;
}

/** F (End of Transmission) record — one A record in this file, zero-fill the rest. */
function buildFRecord(seq: number): string[] {
  const rec = blankRecord();
  put(rec, 1, 1, 'F');
  put(rec, 2, 8, numeric(1, 8)); // number of A records
  put(rec, 10, 21, numeric(0, 21)); // zero field
  putSeq(rec, seq);
  return rec;
}

// ── Public builder ──────────────────────────────────────────────────────────────

/** Which amount codes are present across the batch (always "1"; "4" if any fed w/h). */
function deriveAmountCodes(batch: Form1099Batch): string {
  const hasFed = batch.records.some((r) => (r.box4FederalTaxWithheldCents ?? 0) > 0);
  return hasFed ? '14' : '1';
}

/**
 * Build the complete IRS FIRE file for a payer's READY 1099-NEC batch. Only
 * `batch.records` (fully-documented READY recipients) become B records — a
 * missing-TIN/W-9 contractor is excluded by construction upstream and can never
 * reach the file. Returns the file plus loud warnings for any placeholder/config gap.
 */
export function buildFireFile(batch: Form1099Batch, opts: BuildFireOptions): FireFileResult {
  const warnings: string[] = [];
  const t = opts.transmitter;

  // Degrade-safe required fields.
  let hasPlaceholders = false;
  if (!t.tcc || !t.tcc.trim()) {
    hasPlaceholders = true;
    warnings.push(
      `Transmitter Control Code (TCC) is not configured — placeholder "${TCC_PLACEHOLDER}" was emitted. ` +
        'The file is NOT transmittable to IRS FIRE until a real 5-character TCC is set.',
    );
  }
  if (normalizeTin(t.tin).length !== 9) {
    hasPlaceholders = true;
    warnings.push(
      'Transmitter TIN is missing or not 9 digits — zero placeholder emitted. Set the transmitter/filer EIN before uploading.',
    );
  }
  if (normalizeTin(batch.payer.tin).length !== 9) {
    hasPlaceholders = true;
    warnings.push(
      'Payer EIN is missing or not 9 digits — zero placeholder emitted. A valid payer EIN is required on every 1099.',
    );
  }
  if (batch.records.length === 0) {
    warnings.push(
      'No READY 1099-NEC recipients — the file contains zero payee (B) records. Resolve blockers or confirm candidates first.',
    );
  }
  if (t.testFile) {
    warnings.push('TEST file: the T record test indicator is set. Uploads to the FIRE *test* system only, not a real filing.');
  }
  warnings.push(
    'Recipient name-control values are derived best-effort (first 4 alphanumerics). The IRS derives its own from the SSA/EIN record; a mismatch is a notice, not a rejection.',
  );

  const amountCodes = deriveAmountCodes(batch);
  const totalBox1 = batch.records.reduce((s, r) => s + (r.box1NonemployeeCompCents || 0), 0);
  const totalBox4 = batch.records.reduce((s, r) => s + (r.box4FederalTaxWithheldCents || 0), 0);

  const records: string[][] = [];
  let seq = 1;
  records.push(buildTRecord(opts, batch.records.length, seq++));
  records.push(buildARecord(batch, opts.taxYear, amountCodes, seq++));
  for (const r of batch.records) {
    records.push(buildBRecord(r, opts.taxYear, seq++));
  }
  records.push(buildCRecord(batch, totalBox1, totalBox4, seq++));
  records.push(buildFRecord(seq++));

  // Each record is exactly 750 positions; CRLF-terminate per Pub. 1220.
  const content = records.map((r) => r.join('')).join('\r\n') + '\r\n';

  return {
    content,
    warnings,
    recordCount: records.length,
    payeeCount: batch.records.length,
    hasPlaceholders,
  };
}
