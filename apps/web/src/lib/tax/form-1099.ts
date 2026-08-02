/**
 * 1099-NEC GENERATION — the deterministic assembly that turns 1099 readiness data
 * (see app/api/compliance/1099/readiness.ts) into filable 1099-NEC records, an
 * IRS-import e-file, and a filing summary. Read-only assembly: this module never
 * files with the IRS, never writes the ledger, and never moves money — a human
 * reviews and transmits (canon §3: AI/automation proposes; a human acts).
 *
 * CPA framing (docs/discovery/books/cpa-tax-assurance.md §A3/§B4): a vendor gets a
 * 1099-NEC when it was paid **$600 or more** for services in the calendar year by a
 * REPORTABLE rail (cash / check / ACH / wire). Card / third-party-network payments
 * are EXCLUDED (those land on the processor's 1099-K; issuing a NEC on top would
 * double-report). Box 1 (nonemployee compensation) is exactly that reportable,
 * non-card total. Corporations / exempt payees are excluded.
 *
 * PURITY: everything here is a pure function of its inputs — no I/O, no clock, no
 * randomness — so the same batch renders identical bytes and can be unit-tested
 * without a DB (form-1099.test.ts). All money is bigint-safe integer cents; dollars
 * are only ever produced at the file boundary via integer arithmetic (never float).
 */

import type { W9State } from '@/app/api/compliance/1099/readiness';

/** IRS reporting floor: paid $600 OR MORE (not strictly "over") in the tax year. */
export const REPORTABLE_THRESHOLD_CENTS = 60_000;

// ── Inputs ────────────────────────────────────────────────────────────────────

/** The filing entity (payer). TIN here is the payer EIN. */
export interface PayerInfo {
  name: string;
  /** Payer EIN (9 digits; may arrive formatted — normalized on output). */
  tin: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone: string | null;
}

export interface RecipientAddress {
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

/** Optional state-withholding facts (NEC boxes 5/6/7). */
export interface StateWithholding {
  /** Two-letter state code (box 6, first half). */
  state: string;
  /** Payer's state id number (box 6, second half). */
  payerStateNo: string | null;
  /** State income-tax withheld, cents (box 5). */
  stateTaxWithheldCents: number;
  /** State income, cents (box 7). Defaults to box 1 when omitted by the caller. */
  stateIncomeCents: number | null;
}

/** A single reportable payment, used to (re)derive Box 1 defensively. */
export interface RailPayment {
  amountCents: number;
  method: string | null;
  rail: string | null;
}

/**
 * One 1099 candidate as handed to assembly. `totalPaidCents` is the reportable
 * (non-card) total already computed by readiness; when `payments` is supplied Box 1
 * is recomputed from it as a double-guard so a card payment can never leak into Box 1.
 */
export interface RecipientInput {
  vendorId: string;
  vendorName: string;
  totalPaidCents: number;
  paymentCount: number;
  is1099Eligible: boolean;
  w9Status: W9State;
  /** The recipient TIN (SSN/EIN) as stored on the vendor; null when absent. */
  tin: string | null;
  address: RecipientAddress;
  /** Optional raw payments — when present, Box 1 is re-summed excluding card rails. */
  payments?: RailPayment[];
  /** Optional federal income-tax withheld (backup withholding), cents (box 4). */
  federalTaxWithheldCents?: number;
  /** Optional state boxes. */
  state?: StateWithholding | null;
}

// ── Outputs ───────────────────────────────────────────────────────────────────

export type RecordStatus = 'READY' | 'BLOCKED' | 'EXCLUDED';

/** A single state line on the NEC (boxes 5/6/7). */
export interface Form1099StateLine {
  box5StateTaxWithheldCents: number;
  box6State: string;
  box6PayerStateNo: string | null;
  box7StateIncomeCents: number;
}

/** A fully-assembled, filable 1099-NEC record (Box 1 = nonemployee compensation). */
export interface Form1099NecRecord {
  vendorId: string;
  recipientName: string;
  /** Full recipient TIN — used only for the e-file, never surfaced to the browser. */
  recipientTin: string;
  /** Truncated TIN (XXX-XX-1234) — safe for display and the recipient Copy B. */
  recipientTinMasked: string;
  address: RecipientAddress;
  box1NonemployeeCompCents: number;
  box4FederalTaxWithheldCents: number;
  stateLines: Form1099StateLine[];
}

/** A candidate kept out of the file, with a machine + human reason. */
export interface Form1099Exclusion {
  vendorId: string;
  vendorName: string;
  totalPaidCents: number;
  status: Exclude<RecordStatus, 'READY'>;
  /** Stable reason code. */
  code:
    | 'BELOW_THRESHOLD'
    | 'NOT_1099_ELIGIBLE'
    | 'MISSING_TIN'
    | 'MISSING_W9';
  reason: string;
  /** True when the human can fix it and re-generate (a chase item, not a decision). */
  fixFirst: boolean;
}

export interface Form1099Summary {
  taxYear: number;
  thresholdCents: number;
  /** Records that will be filed. */
  readyCount: number;
  /** Sum of Box 1 across ready records (cents). */
  totalNonemployeeCompCents: number;
  /** Eligible candidates blocked by a missing TIN / W-9 — the fix-first list. */
  blockedCount: number;
  /** Reportable $ sitting behind blocked candidates (cents). */
  blockedDollarsCents: number;
  /** Candidates excluded (below threshold or not 1099-eligible). */
  excludedCount: number;
  /** True when the payer EIN is missing — a filing blocker independent of recipients. */
  payerTinMissing: boolean;
}

export interface Form1099Batch {
  payer: PayerInfo;
  summary: Form1099Summary;
  records: Form1099NecRecord[];
  /** BLOCKED + EXCLUDED, gaps first. Blocked (fix-first) sort ahead of excluded. */
  exclusions: Form1099Exclusion[];
}

// ── Pure helpers ────────────────────────────────────────────────────────────────

/** Card / third-party-network rails are 1099-K, never 1099-NEC — exclude them. */
export function isReportableRail(method: string | null, rail: string | null): boolean {
  const m = (method ?? '').toUpperCase();
  const r = (rail ?? '').toUpperCase();
  if (m.includes('CARD') || r.includes('CARD')) return false;
  return true;
}

/** Box 1 nonemployee comp from raw payments, excluding card rails. Integer cents. */
export function box1FromPayments(payments: RailPayment[]): number {
  return payments.reduce(
    (sum, p) => (isReportableRail(p.method, p.rail) ? sum + (Number(p.amountCents) || 0) : sum),
    0,
  );
}

/** Digits only. "12-3456789" → "123456789". */
export function normalizeTin(tin: string | null | undefined): string {
  return (tin ?? '').replace(/\D/g, '');
}

/** True when a TIN has the 9 digits the IRS requires. */
export function isValidTin(tin: string | null | undefined): boolean {
  return normalizeTin(tin).length === 9;
}

/** Format an EIN as NN-NNNNNNN (payer). Falls back to the raw string if not 9 digits. */
export function formatEin(tin: string | null | undefined): string {
  const d = normalizeTin(tin);
  return d.length === 9 ? `${d.slice(0, 2)}-${d.slice(2)}` : (tin ?? '');
}

/** Truncated TIN safe for a recipient copy / UI: XXX-XX-1234 (IRS-permitted on Copy B). */
export function maskTin(tin: string | null | undefined): string {
  const d = normalizeTin(tin);
  if (d.length < 4) return 'XXX-XX-XXXX';
  return `XXX-XX-${d.slice(-4)}`;
}

/** Integer cents → a fixed 2-decimal dollar string, no float rounding. "-12345" → "-123.45". */
export function centsToAmountString(cents: number): string {
  const n = Math.trunc(Number(cents) || 0);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  return `${sign}${whole}.${String(frac).padStart(2, '0')}`;
}

// ── Classification & assembly ──────────────────────────────────────────────────

/**
 * Decide how a single candidate is treated. Order matters:
 *   BELOW_THRESHOLD → not a 1099 at all.
 *   NOT_1099_ELIGIBLE → excluded (likely a corporation / exempt payee — a CPA
 *                       confirms; it is not filed until marked eligible).
 *   MISSING_TIN / MISSING_W9 → BLOCKED (eligible but undocumented; fix-first).
 *   else READY.
 */
export function classifyRecipient(
  input: RecipientInput,
): { status: RecordStatus; code?: Form1099Exclusion['code'] } {
  const box1 = input.payments ? box1FromPayments(input.payments) : input.totalPaidCents;
  if (box1 < REPORTABLE_THRESHOLD_CENTS) return { status: 'EXCLUDED', code: 'BELOW_THRESHOLD' };
  if (!input.is1099Eligible) return { status: 'EXCLUDED', code: 'NOT_1099_ELIGIBLE' };
  if (!isValidTin(input.tin)) return { status: 'BLOCKED', code: 'MISSING_TIN' };
  if (input.w9Status !== 'on_file') return { status: 'BLOCKED', code: 'MISSING_W9' };
  return { status: 'READY' };
}

function exclusionReason(code: Form1099Exclusion['code'], name: string): string {
  switch (code) {
    case 'BELOW_THRESHOLD':
      return `${name} was paid under the $600 1099-NEC floor by reportable rails — no form required.`;
    case 'NOT_1099_ELIGIBLE':
      return `${name} crossed $600 but is not flagged 1099-eligible. Confirm entity type (a corporation is exempt) or mark it eligible before filing.`;
    case 'MISSING_TIN':
      return `${name} is 1099-eligible but has no valid TIN on file. Collect a W-9 (name + TIN) before filing to avoid backup withholding / penalties.`;
    case 'MISSING_W9':
      return `${name} is 1099-eligible with a TIN, but the W-9 is not on file. Collect / re-confirm the W-9 before filing.`;
  }
}

/**
 * Assemble a full 1099-NEC batch for a payer + tax year from the candidate list.
 * Deterministic and side-effect free.
 */
export function assembleForm1099Batch(
  payer: PayerInfo,
  recipients: RecipientInput[],
  taxYear: number,
): Form1099Batch {
  const records: Form1099NecRecord[] = [];
  const exclusions: Form1099Exclusion[] = [];

  for (const input of recipients) {
    const box1 = input.payments ? box1FromPayments(input.payments) : input.totalPaidCents;
    const { status, code } = classifyRecipient(input);

    if (status === 'READY') {
      const stateLines: Form1099StateLine[] = input.state
        ? [
            {
              box5StateTaxWithheldCents: input.state.stateTaxWithheldCents,
              box6State: input.state.state,
              box6PayerStateNo: input.state.payerStateNo,
              box7StateIncomeCents: input.state.stateIncomeCents ?? box1,
            },
          ]
        : [];
      records.push({
        vendorId: input.vendorId,
        recipientName: input.vendorName,
        recipientTin: normalizeTin(input.tin),
        recipientTinMasked: maskTin(input.tin),
        address: input.address,
        box1NonemployeeCompCents: box1,
        box4FederalTaxWithheldCents: input.federalTaxWithheldCents ?? 0,
        stateLines,
      });
    } else {
      exclusions.push({
        vendorId: input.vendorId,
        vendorName: input.vendorName,
        totalPaidCents: box1,
        status,
        code: code!,
        reason: exclusionReason(code!, input.vendorName),
        fixFirst: status === 'BLOCKED',
      });
    }
  }

  // Records: largest comp first (the CPA reviews the big ones hardest).
  records.sort((a, b) => b.box1NonemployeeCompCents - a.box1NonemployeeCompCents);
  // Exclusions: fix-first (BLOCKED) ahead of EXCLUDED, then largest dollars.
  exclusions.sort(
    (a, b) => Number(b.fixFirst) - Number(a.fixFirst) || b.totalPaidCents - a.totalPaidCents,
  );

  const blocked = exclusions.filter((e) => e.status === 'BLOCKED');
  const summary: Form1099Summary = {
    taxYear,
    thresholdCents: REPORTABLE_THRESHOLD_CENTS,
    readyCount: records.length,
    totalNonemployeeCompCents: records.reduce((s, r) => s + r.box1NonemployeeCompCents, 0),
    blockedCount: blocked.length,
    blockedDollarsCents: blocked.reduce((s, e) => s + e.totalPaidCents, 0),
    excludedCount: exclusions.length - blocked.length,
    payerTinMissing: !isValidTin(payer.tin),
  };

  return { payer, summary, records, exclusions };
}

// ── IRS-import e-file (filing-service CSV) ───────────────────────────────────────

/**
 * The CSV column order. This is the pragmatic, flat 1099-NEC layout that filing
 * services (Track1099, Tax1099, Yearli, etc.) accept for bulk import — one row per
 * recipient, amounts in dollars. We deliberately DON'T emit the IRS FIRE/IRIS
 * fixed-width transmittal here: that requires a TCC and belongs to the filing
 * service's transmit step (canon: no direct IRS transmit this wave). A service
 * validates + produces the FIRE file from this import.
 */
export const NEC_CSV_COLUMNS = [
  'Form Type',
  'Tax Year',
  'Payer Name',
  'Payer TIN',
  'Payer Address',
  'Payer City',
  'Payer State',
  'Payer Zip',
  'Payer Phone',
  'Recipient Name',
  'Recipient TIN',
  'Recipient Address 1',
  'Recipient Address 2',
  'Recipient City',
  'Recipient State',
  'Recipient Zip',
  'Account Number',
  'Box 1 Nonemployee Compensation',
  'Box 4 Federal Tax Withheld',
  'Box 5 State Tax Withheld',
  'Box 6 State/Payer State No',
  'Box 7 State Income',
] as const;

/** RFC-4180-safe CSV cell: quote when it contains comma / quote / newline. */
function csvCell(value: string | number | null | undefined): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function payerAddressLine(p: PayerInfo): string {
  return [p.addressLine1, p.addressLine2].filter(Boolean).join(', ');
}

/**
 * Serialize the filable READY records to the filing-service import CSV. Only READY
 * records are emitted — a blocked (missing-TIN/W-9) contractor is, by construction,
 * never in `batch.records`, so it cannot reach the file.
 */
export function toNecImportCsv(batch: Form1099Batch): string {
  const p = batch.payer;
  const header = NEC_CSV_COLUMNS.map(csvCell).join(',');
  const rows = batch.records.map((r) => {
    const s = r.stateLines[0];
    return [
      '1099-NEC',
      batch.summary.taxYear,
      p.name,
      formatEin(p.tin),
      payerAddressLine(p),
      p.city,
      p.state,
      p.zip,
      p.phone,
      r.recipientName,
      // Recipient TIN with dashes preserved as digits-only for import robustness.
      normalizeTin(r.recipientTin),
      r.address.line1,
      r.address.line2,
      r.address.city,
      r.address.state,
      r.address.zip,
      '', // Account Number (optional; blank unless the service requires uniqueness)
      centsToAmountString(r.box1NonemployeeCompCents),
      centsToAmountString(r.box4FederalTaxWithheldCents),
      s ? centsToAmountString(s.box5StateTaxWithheldCents) : '',
      s ? s.box6State + (s.box6PayerStateNo ? `/${s.box6PayerStateNo}` : '') : '',
      s ? centsToAmountString(s.box7StateIncomeCents) : '',
    ]
      .map(csvCell)
      .join(',');
  });
  return [header, ...rows].join('\r\n') + '\r\n';
}

/** A filesystem-safe slug from a name (for filenames). */
export function slugify(name: string): string {
  return name.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'payer';
}
