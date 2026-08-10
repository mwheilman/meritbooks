/**
 * IRS FIRE electronic-filing file for Form 1099-MISC (IRS Publication 1220 layout).
 *
 * The MISC sibling of fire-file.ts (1099-NEC): the same fixed-width, 750-position
 * T/A/B/C/F record structure the IRS FIRE system ingests, re-serializing the READY
 * 1099-MISC records. Only the A-record "Type of Return" ("A" for MISC) and the
 * per-box payment amount codes differ from the NEC file — everything else (record
 * geometry, sequence numbers, degrade-safe placeholders) is shared, importing the
 * exact same fixed-width primitives from fire-file.ts so the two files can never
 * drift.
 *
 * MISC payment amount codes (Pub. 1220), for the boxes box-classify.ts produces:
 *   Code 1 = Box 1  Rents            (payment field 1, pos 55-66)
 *   Code 2 = Box 2  Royalties        (payment field 2, pos 67-78)
 *   Code 3 = Box 3  Other income     (payment field 3, pos 79-90)
 *   Code 4 = Box 4  Fed tax withheld (payment field 4, pos 91-102)
 *   Code 6 = Box 6  Medical/health   (payment field 6, pos 115-126)
 *   Code B = Box 10 Attorney proceeds(payment field 11 / "B", pos 175-186)
 *
 * PURITY & SAFETY: identical guarantees to the NEC file — pure function of its
 * inputs (unit-testable without a DB), FILE ONLY (never contacts the IRS / moves
 * money), integer-cents money, and degrade-safe required fields (TCC / TIN emit a
 * loud placeholder + warning rather than a silently-invalid file).
 *
 * Reference: IRS Pub. 1220, record layouts + 1099-MISC amount codes.
 */

import type { Form1099MiscBatch, Form1099MiscRecord, MiscBoxCode } from '../form-1099-misc';
import { MISC_BOX_CODES, miscBoxAmount } from '../form-1099-misc';
import { normalizeTin } from '../form-1099';
import {
  FIRE_RECORD_LENGTH,
  TCC_PLACEHOLDER,
  nameControl,
  blankRecord,
  put,
  alpha,
  numeric,
  money,
  putSeq,
  type BuildFireOptions,
  type FireFileResult,
} from './fire-file';

/** 1099-MISC "Type of Return" code (A record, positions 26-27). */
export const MISC_TYPE_OF_RETURN = 'A';

/** Federal income tax withheld is amount code 4 across every 1099 series. */
const FED_WITHHELD_CODE = '4';

/** MISC box code → IRS amount code (Pub. 1220). Box 10 attorney proceeds = code "B". */
export const MISC_BOX_AMOUNT_CODE: Record<MiscBoxCode, string> = {
  MISC_1: '1',
  MISC_2: '2',
  MISC_3: '3',
  MISC_6: '6',
  MISC_10: 'B',
};

// ── Amount-code geometry ─────────────────────────────────────────────────────────

/**
 * 1-based ordinal of an amount code: '1'..'9' → 1..9, then 'A' → 10, 'B' → 11, …
 * Payment amount fields and control-total fields both index off this ordinal.
 */
export function amountCodeOrdinal(code: string): number {
  return code >= '1' && code <= '9'
    ? Number(code)
    : 9 + (code.toUpperCase().charCodeAt(0) - 'A'.charCodeAt(0) + 1);
}

/** B-record payment amount field start (1-based). Field n is 12 wide from pos 55. */
export function paymentAmountStart(code: string): number {
  return 55 + (amountCodeOrdinal(code) - 1) * 12;
}

/** C-record control total field start (1-based). CT n is 18 wide from pos 16. */
export function controlTotalStart(code: string): number {
  return 16 + (amountCodeOrdinal(code) - 1) * 18;
}

/** Sort amount codes into filing order (numeric codes ascending, then letters). */
function sortAmountCodes(codes: Iterable<string>): string[] {
  return [...new Set(codes)].sort((a, b) => amountCodeOrdinal(a) - amountCodeOrdinal(b));
}

// ── Record builders ─────────────────────────────────────────────────────────────

function buildTRecord(o: BuildFireOptions, payeeCount: number, seq: number): string[] {
  const t = o.transmitter;
  const rec = blankRecord();
  put(rec, 1, 1, 'T');
  put(rec, 2, 4, numeric(o.taxYear, 4));
  put(rec, 7, 9, numeric(t.tin, 9));
  put(rec, 16, 5, alpha(t.tcc && t.tcc.trim() ? t.tcc : TCC_PLACEHOLDER, 5));
  if (t.testFile) put(rec, 28, 1, 'T');
  put(rec, 30, 40, alpha(t.name, 40));
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
  batch: Form1099MiscBatch,
  taxYear: number,
  amountCodes: string,
  seq: number,
): string[] {
  const p = batch.payer;
  const rec = blankRecord();
  put(rec, 1, 1, 'A');
  put(rec, 2, 4, numeric(taxYear, 4));
  put(rec, 12, 9, numeric(p.tin, 9));
  put(rec, 21, 4, nameControl(p.name)); // payer name control (optional)
  put(rec, 26, 2, alpha(MISC_TYPE_OF_RETURN, 2)); // "A " = 1099-MISC
  put(rec, 28, 16, amountCodes.padEnd(16, ' ')); // amount codes, left-justified
  put(rec, 53, 40, alpha(p.name, 40));
  put(rec, 133, 1, '0'); // transfer-agent indicator: 0 = payer is the filer
  put(rec, 134, 40, alpha(p.addressLine1, 40));
  put(rec, 174, 40, alpha(p.city, 40));
  put(rec, 214, 2, alpha(p.state, 2));
  put(rec, 216, 9, numeric(p.zip, 9));
  put(rec, 225, 15, alpha(p.phone, 15));
  putSeq(rec, seq);
  return rec;
}

/** B (payee) record — each MISC box lands in its Pub.1220 payment amount field. */
function buildBRecord(r: Form1099MiscRecord, taxYear: number, seq: number): string[] {
  const rec = blankRecord();
  put(rec, 1, 1, 'B');
  put(rec, 2, 4, numeric(taxYear, 4));
  put(rec, 7, 4, nameControl(r.recipientName));
  put(rec, 12, 9, numeric(r.recipientTin, 9));
  put(rec, 21, 20, alpha(r.vendorId.replace(/-/g, ''), 20)); // payer's account number for payee
  // Payment amounts, one per box present.
  for (const code of MISC_BOX_CODES) {
    const cents = miscBoxAmount(r.boxAmounts, code);
    if (cents > 0) put(rec, paymentAmountStart(MISC_BOX_AMOUNT_CODE[code]), 12, money(cents, 12));
  }
  if ((r.box4FederalTaxWithheldCents ?? 0) > 0)
    put(rec, paymentAmountStart(FED_WITHHELD_CODE), 12, money(r.box4FederalTaxWithheldCents, 12));
  put(rec, 248, 40, alpha(r.recipientName, 40));
  put(rec, 368, 40, alpha(r.address.line1, 40));
  put(rec, 448, 40, alpha(r.address.city, 40));
  put(rec, 488, 2, alpha(r.address.state, 2));
  put(rec, 490, 9, numeric(r.address.zip, 9));
  putSeq(rec, seq);
  return rec;
}

/** C (End of Payer) record — payee count + a control total per amount code present. */
function buildCRecord(
  batch: Form1099MiscBatch,
  amountCodes: string[],
  totals: Map<string, number>,
  seq: number,
): string[] {
  const rec = blankRecord();
  put(rec, 1, 1, 'C');
  put(rec, 2, 8, numeric(batch.records.length, 8));
  for (const code of amountCodes) {
    put(rec, controlTotalStart(code), 18, money(totals.get(code) ?? 0, 18));
  }
  putSeq(rec, seq);
  return rec;
}

/** F (End of Transmission) record — one A record in this file, zero-fill the rest. */
function buildFRecord(seq: number): string[] {
  const rec = blankRecord();
  put(rec, 1, 1, 'F');
  put(rec, 2, 8, numeric(1, 8));
  put(rec, 10, 21, numeric(0, 21));
  putSeq(rec, seq);
  return rec;
}

// ── Public builder ──────────────────────────────────────────────────────────────

/** Amount codes present across the batch + the control total per code (cents). */
function deriveAmountsAndTotals(batch: Form1099MiscBatch): {
  codes: string[];
  totals: Map<string, number>;
} {
  const totals = new Map<string, number>();
  for (const r of batch.records) {
    for (const box of MISC_BOX_CODES) {
      const cents = miscBoxAmount(r.boxAmounts, box);
      if (cents > 0) {
        const code = MISC_BOX_AMOUNT_CODE[box];
        totals.set(code, (totals.get(code) ?? 0) + cents);
      }
    }
    if ((r.box4FederalTaxWithheldCents ?? 0) > 0) {
      totals.set(FED_WITHHELD_CODE, (totals.get(FED_WITHHELD_CODE) ?? 0) + r.box4FederalTaxWithheldCents);
    }
  }
  return { codes: sortAmountCodes(totals.keys()), totals };
}

/**
 * Build the complete IRS FIRE file for a payer's READY 1099-MISC batch. Only
 * `batch.records` (fully-documented READY recipients) become B records — a
 * missing-TIN/W-9 recipient is excluded by construction upstream and can never reach
 * the file. Returns the file plus loud warnings for any placeholder/config gap.
 */
export function buildMiscFireFile(batch: Form1099MiscBatch, opts: BuildFireOptions): FireFileResult {
  const warnings: string[] = [];
  const t = opts.transmitter;

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
      'No READY 1099-MISC recipients — the file contains zero payee (B) records. Resolve blockers or confirm candidates first.',
    );
  }
  if (t.testFile) {
    warnings.push('TEST file: the T record test indicator is set. Uploads to the FIRE *test* system only, not a real filing.');
  }
  warnings.push(
    'Recipient name-control values are derived best-effort (first 4 alphanumerics). The IRS derives its own from the SSA/EIN record; a mismatch is a notice, not a rejection.',
  );

  const { codes, totals } = deriveAmountsAndTotals(batch);
  const amountCodesStr = codes.join('');

  const records: string[][] = [];
  let seq = 1;
  records.push(buildTRecord(opts, batch.records.length, seq++));
  records.push(buildARecord(batch, opts.taxYear, amountCodesStr, seq++));
  for (const r of batch.records) {
    records.push(buildBRecord(r, opts.taxYear, seq++));
  }
  records.push(buildCRecord(batch, codes, totals, seq++));
  records.push(buildFRecord(seq++));

  // Each record is exactly 750 positions; CRLF-terminate per Pub. 1220.
  const content = records.map((r) => r.join('')).join('\r\n') + '\r\n';
  // Defensive: assert width so a bad `put` offset fails a test, never ships silently.
  for (const line of content.split('\r\n')) {
    if (line.length > 0 && line.length !== FIRE_RECORD_LENGTH) {
      warnings.push(`Internal: a FIRE record was ${line.length} positions (expected ${FIRE_RECORD_LENGTH}).`);
    }
  }

  return {
    content,
    warnings,
    recordCount: records.length,
    payeeCount: batch.records.length,
    hasPlaceholders,
  };
}
