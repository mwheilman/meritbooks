/**
 * 1099-MISC GENERATION — the deterministic assembly that turns 1099 readiness data
 * (see app/api/compliance/1099/readiness.ts) into filable 1099-MISC records, an
 * IRS-import e-file (see 1099/fire-file-misc.ts), and a filing summary. It is the
 * MISC sibling of form-1099.ts (1099-NEC): identical spine, exclusions, and card
 * carve-out — only the boxes differ. Read-only assembly: this module never files
 * with the IRS, never writes the ledger, and never moves money — a human reviews and
 * transmits (canon §3: AI/automation proposes; a human acts).
 *
 * CPA framing (docs/discovery/books/cpa-tax-assurance.md §A3/§B4): the OWNED general
 * ledger already tells us which GL expense account each reportable dollar was coded
 * to, and box-classify.ts routes that to the correct MISC box:
 *   - Box 1  Rents            (MISC_1)   — $600 floor
 *   - Box 2  Royalties        (MISC_2)   — $10 floor (the ONE sub-$600 box)
 *   - Box 3  Other income     (MISC_3)   — $600 floor (prizes / awards / other)
 *   - Box 6  Medical/health   (MISC_6)   — $600 floor
 *   - Box 10 Attorney proceeds(MISC_10)  — $600 floor (gross proceeds / settlements)
 * Card / third-party-network payments are EXCLUDED (those land on the processor's
 * 1099-K; the readiness aggregation already strips card rails before apportioning to
 * boxes, and this module double-guards against it). A vendor produces a 1099-MISC
 * when AT LEAST ONE box clears its own threshold; corporations / exempt payees are
 * excluded (attorney gross proceeds are reportable even to a corporation — a known
 * simplification: we mirror the NEC eligibility gate, which a CPA overrides by
 * marking the vendor 1099-eligible).
 *
 * PURITY: everything here is a pure function of its inputs — no I/O, no clock, no
 * randomness — so the same batch renders identical bytes and can be unit-tested
 * without a DB (form-1099-misc.test.ts). All money is bigint-safe integer cents;
 * dollars are only ever produced at the file boundary via integer arithmetic.
 */

import type { W9State } from '@/app/api/compliance/1099/readiness';
import { BOX_META } from '@/lib/tax/box-classify';
import {
  box1FromPayments,
  isValidTin,
  normalizeTin,
  maskTin,
  formatEin,
  centsToAmountString,
  csvCell,
  payerAddressLine,
  type PayerInfo,
  type RecipientAddress,
  type StateWithholding,
  type RailPayment,
  type Form1099StateLine,
  type Form1099Exclusion,
  type RecordStatus,
} from '@/lib/tax/form-1099';

// ── Boxes this module files ─────────────────────────────────────────────────────

/** The 1099-MISC box codes we classify + file (subset of box-classify's Box1099Code). */
export type MiscBoxCode = 'MISC_1' | 'MISC_2' | 'MISC_3' | 'MISC_6' | 'MISC_10';

export const MISC_BOX_CODES: MiscBoxCode[] = ['MISC_1', 'MISC_2', 'MISC_3', 'MISC_6', 'MISC_10'];

/** General MISC reporting floor: paid $600 OR MORE in the tax year. */
export const MISC_GENERAL_THRESHOLD_CENTS = 60_000;
/** Royalties (Box 2) have a lower $10 floor — the only sub-$600 MISC box. */
export const MISC_ROYALTY_THRESHOLD_CENTS = 1_000;

/** Per-box filing threshold (cents). Box 2 (royalties) is $10; everything else $600. */
export const MISC_BOX_THRESHOLD_CENTS: Record<MiscBoxCode, number> = {
  MISC_1: MISC_GENERAL_THRESHOLD_CENTS,
  MISC_2: MISC_ROYALTY_THRESHOLD_CENTS,
  MISC_3: MISC_GENERAL_THRESHOLD_CENTS,
  MISC_6: MISC_GENERAL_THRESHOLD_CENTS,
  MISC_10: MISC_GENERAL_THRESHOLD_CENTS,
};

/** A box→cents map of the MISC-classified reportable spend for one vendor. */
export type MiscBoxCents = Partial<Record<MiscBoxCode, number>>;

// ── Inputs ────────────────────────────────────────────────────────────────────

/**
 * One 1099-MISC candidate as handed to assembly. `miscBoxCents` is the per-box,
 * non-card (reportable) total already classified by readiness from the GL expense
 * coding. When `payments` is supplied the card carve-out is re-verified defensively
 * so a card (1099-K) payment can never leak into a MISC box.
 */
export interface RecipientMiscInput {
  vendorId: string;
  vendorName: string;
  /** Total reportable (non-card) payments to the vendor in the year, cents (for display). */
  totalPaidCents: number;
  paymentCount: number;
  is1099Eligible: boolean;
  w9Status: W9State;
  /** The recipient TIN (SSN/EIN) as stored on the vendor; null when absent. */
  tin: string | null;
  address: RecipientAddress;
  /** The MISC-classified spend split across MISC boxes (cents). */
  miscBoxCents: MiscBoxCents;
  /** Optional raw payments — when present, an all-card vendor is excluded defensively. */
  payments?: RailPayment[];
  /** Optional federal income-tax withheld (backup withholding), cents (Box 4). */
  federalTaxWithheldCents?: number;
  /** Optional state boxes (MISC 15/16/17). */
  state?: StateWithholding | null;
}

// ── Outputs ───────────────────────────────────────────────────────────────────

/** A fully-assembled, filable 1099-MISC record — amounts keyed by MISC box code. */
export interface Form1099MiscRecord {
  vendorId: string;
  recipientName: string;
  /** Full recipient TIN — used only for the e-file, never surfaced to the browser. */
  recipientTin: string;
  /** Truncated TIN (XXX-XX-1234) — safe for display and the recipient Copy B. */
  recipientTinMasked: string;
  address: RecipientAddress;
  /** Per-box reportable amounts (cents). Only boxes with dollars are present. */
  boxAmounts: MiscBoxCents;
  box4FederalTaxWithheldCents: number;
  stateLines: Form1099StateLine[];
  /** Sum of all MISC boxes for this record (cents) — for sorting + the summary. */
  totalReportableMiscCents: number;
}

export interface Form1099MiscSummary {
  taxYear: number;
  generalThresholdCents: number;
  royaltyThresholdCents: number;
  /** Records that will be filed. */
  readyCount: number;
  /** Sum of every MISC box across ready records (cents). */
  totalReportableMiscCents: number;
  /** Per-box totals across ready records (cents) — drives the C record + summary. */
  boxTotals: MiscBoxCents;
  /** Eligible candidates blocked by a missing TIN / W-9 — the fix-first list. */
  blockedCount: number;
  /** Reportable $ sitting behind blocked candidates (cents). */
  blockedDollarsCents: number;
  /** Candidates excluded (below threshold or not 1099-eligible). */
  excludedCount: number;
  /** True when the payer EIN is missing — a filing blocker independent of recipients. */
  payerTinMissing: boolean;
}

export interface Form1099MiscBatch {
  payer: PayerInfo;
  summary: Form1099MiscSummary;
  records: Form1099MiscRecord[];
  /** BLOCKED + EXCLUDED, gaps first. Blocked (fix-first) sort ahead of excluded. */
  exclusions: Form1099Exclusion[];
}

// ── Pure helpers ────────────────────────────────────────────────────────────────

/** Positive per-box amount from a box map (defensive: floors negatives + junk at 0). */
export function miscBoxAmount(boxes: MiscBoxCents, code: MiscBoxCode): number {
  return Math.max(0, Math.trunc(Number(boxes[code]) || 0));
}

/** Sum of every MISC box for a candidate (cents). */
export function sumMiscBoxes(boxes: MiscBoxCents): number {
  return MISC_BOX_CODES.reduce((s, code) => s + miscBoxAmount(boxes, code), 0);
}

/** True when at least one box clears its own filing threshold (Box 2 = $10, else $600). */
export function meetsAnyMiscThreshold(boxes: MiscBoxCents): boolean {
  return MISC_BOX_CODES.some((code) => miscBoxAmount(boxes, code) >= MISC_BOX_THRESHOLD_CENTS[code]);
}

// ── Classification & assembly ──────────────────────────────────────────────────

/**
 * Decide how a single candidate is treated. Order matters:
 *   BELOW_THRESHOLD → no box clears its floor (or the payments were all card).
 *   NOT_1099_ELIGIBLE → excluded (likely a corporation / exempt payee).
 *   MISSING_TIN / MISSING_W9 → BLOCKED (eligible but undocumented; fix-first).
 *   else READY.
 */
export function classifyMiscRecipient(
  input: RecipientMiscInput,
): { status: RecordStatus; code?: Form1099Exclusion['code'] } {
  // Defensive card carve-out: if raw payments are supplied and NONE are reportable
  // (all card / third-party network → 1099-K), there is no 1099-MISC to file.
  if (input.payments && box1FromPayments(input.payments) === 0)
    return { status: 'EXCLUDED', code: 'BELOW_THRESHOLD' };
  if (!meetsAnyMiscThreshold(input.miscBoxCents))
    return { status: 'EXCLUDED', code: 'BELOW_THRESHOLD' };
  if (!input.is1099Eligible) return { status: 'EXCLUDED', code: 'NOT_1099_ELIGIBLE' };
  if (!isValidTin(input.tin)) return { status: 'BLOCKED', code: 'MISSING_TIN' };
  if (input.w9Status !== 'on_file') return { status: 'BLOCKED', code: 'MISSING_W9' };
  return { status: 'READY' };
}

function exclusionReason(code: Form1099Exclusion['code'], name: string): string {
  switch (code) {
    case 'BELOW_THRESHOLD':
      return `${name}'s reportable MISC payments are under every box floor ($600 — $10 for royalties), or were paid by card (1099-K) — no 1099-MISC required.`;
    case 'NOT_1099_ELIGIBLE':
      return `${name} has reportable MISC payments but is not flagged 1099-eligible. Confirm entity type (a corporation is generally exempt, though attorney gross proceeds are reportable even to a corp) or mark it eligible before filing.`;
    case 'MISSING_TIN':
      return `${name} is 1099-eligible but has no valid TIN on file. Collect a W-9 (name + TIN) before filing to avoid backup withholding / penalties.`;
    case 'MISSING_W9':
      return `${name} is 1099-eligible with a TIN, but the W-9 is not on file. Collect / re-confirm the W-9 before filing.`;
    // MISC_ONLY belongs to the NEC path only; unreachable here but keeps the union total.
    case 'MISC_ONLY':
      return `${name} belongs on a 1099-NEC, not this MISC batch.`;
  }
}

/** Keep only the boxes that carry dollars (drop zero/empty boxes). */
function presentBoxes(boxes: MiscBoxCents): MiscBoxCents {
  const out: MiscBoxCents = {};
  for (const code of MISC_BOX_CODES) {
    const cents = miscBoxAmount(boxes, code);
    if (cents > 0) out[code] = cents;
  }
  return out;
}

/**
 * Assemble a full 1099-MISC batch for a payer + tax year from the candidate list.
 * Deterministic and side-effect free — the MISC mirror of assembleForm1099Batch.
 */
export function assembleForm1099MiscBatch(
  payer: PayerInfo,
  recipients: RecipientMiscInput[],
  taxYear: number,
): Form1099MiscBatch {
  const records: Form1099MiscRecord[] = [];
  const exclusions: Form1099Exclusion[] = [];

  for (const input of recipients) {
    const { status, code } = classifyMiscRecipient(input);
    const boxAmounts = presentBoxes(input.miscBoxCents);
    const totalReportableMiscCents = sumMiscBoxes(boxAmounts);

    if (status === 'READY') {
      const stateLines: Form1099StateLine[] = input.state
        ? [
            {
              box5StateTaxWithheldCents: input.state.stateTaxWithheldCents,
              box6State: input.state.state,
              box6PayerStateNo: input.state.payerStateNo,
              box7StateIncomeCents: input.state.stateIncomeCents ?? totalReportableMiscCents,
            },
          ]
        : [];
      records.push({
        vendorId: input.vendorId,
        recipientName: input.vendorName,
        recipientTin: normalizeTin(input.tin),
        recipientTinMasked: maskTin(input.tin),
        address: input.address,
        boxAmounts,
        box4FederalTaxWithheldCents: input.federalTaxWithheldCents ?? 0,
        stateLines,
        totalReportableMiscCents,
      });
    } else {
      exclusions.push({
        vendorId: input.vendorId,
        vendorName: input.vendorName,
        // Show the vendor's full reportable total so the operator sees the real dollars.
        totalPaidCents: input.totalPaidCents || totalReportableMiscCents,
        status,
        code: code!,
        reason: exclusionReason(code!, input.vendorName),
        fixFirst: status === 'BLOCKED',
      });
    }
  }

  // Records: largest total MISC first (the CPA reviews the big ones hardest).
  records.sort((a, b) => b.totalReportableMiscCents - a.totalReportableMiscCents);
  // Exclusions: fix-first (BLOCKED) ahead of EXCLUDED, then largest dollars.
  exclusions.sort(
    (a, b) => Number(b.fixFirst) - Number(a.fixFirst) || b.totalPaidCents - a.totalPaidCents,
  );

  const blocked = exclusions.filter((e) => e.status === 'BLOCKED');
  const boxTotals: MiscBoxCents = {};
  for (const r of records) {
    for (const code of MISC_BOX_CODES) {
      const cents = miscBoxAmount(r.boxAmounts, code);
      if (cents > 0) boxTotals[code] = (boxTotals[code] ?? 0) + cents;
    }
  }

  const summary: Form1099MiscSummary = {
    taxYear,
    generalThresholdCents: MISC_GENERAL_THRESHOLD_CENTS,
    royaltyThresholdCents: MISC_ROYALTY_THRESHOLD_CENTS,
    readyCount: records.length,
    totalReportableMiscCents: records.reduce((s, r) => s + r.totalReportableMiscCents, 0),
    boxTotals,
    blockedCount: blocked.length,
    blockedDollarsCents: blocked.reduce((s, e) => s + e.totalPaidCents, 0),
    excludedCount: exclusions.length - blocked.length,
    payerTinMissing: !isValidTin(payer.tin),
  };

  return { payer, summary, records, exclusions };
}

// ── IRS-import e-file (filing-service CSV) ───────────────────────────────────────

/**
 * The MISC CSV column order — the pragmatic, flat 1099-MISC layout filing services
 * (Track1099, Tax1099, Yearli, etc.) accept for bulk import (one row per recipient,
 * amounts in dollars). The IRS's own FIRE fixed-width transmittal is built separately
 * (1099/fire-file-misc.ts); a filing service validates + produces Copy A from this.
 */
export const MISC_CSV_COLUMNS = [
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
  'Box 1 Rents',
  'Box 2 Royalties',
  'Box 3 Other Income',
  'Box 4 Federal Tax Withheld',
  'Box 6 Medical and Health Care Payments',
  'Box 10 Gross Proceeds Paid to an Attorney',
  'Box 16 State Tax Withheld',
  'Box 17 State/Payer State No',
  'Box 18 State Income',
] as const;

/**
 * Serialize the filable READY records to the filing-service import CSV. Only READY
 * records are emitted — a blocked (missing-TIN/W-9) recipient is, by construction,
 * never in `batch.records`, so it cannot reach the file.
 */
export function toMiscImportCsv(batch: Form1099MiscBatch): string {
  const p = batch.payer;
  const header = MISC_CSV_COLUMNS.map(csvCell).join(',');
  const rows = batch.records.map((r) => {
    const s = r.stateLines[0];
    return [
      '1099-MISC',
      batch.summary.taxYear,
      p.name,
      formatEin(p.tin),
      payerAddressLine(p),
      p.city,
      p.state,
      p.zip,
      p.phone,
      r.recipientName,
      normalizeTin(r.recipientTin),
      r.address.line1,
      r.address.line2,
      r.address.city,
      r.address.state,
      r.address.zip,
      '', // Account Number (optional)
      centsToAmountString(miscBoxAmount(r.boxAmounts, 'MISC_1')),
      centsToAmountString(miscBoxAmount(r.boxAmounts, 'MISC_2')),
      centsToAmountString(miscBoxAmount(r.boxAmounts, 'MISC_3')),
      centsToAmountString(r.box4FederalTaxWithheldCents),
      centsToAmountString(miscBoxAmount(r.boxAmounts, 'MISC_6')),
      centsToAmountString(miscBoxAmount(r.boxAmounts, 'MISC_10')),
      s ? centsToAmountString(s.box5StateTaxWithheldCents) : '',
      s ? s.box6State + (s.box6PayerStateNo ? `/${s.box6PayerStateNo}` : '') : '',
      s ? centsToAmountString(s.box7StateIncomeCents) : '',
    ]
      .map(csvCell)
      .join(',');
  });
  return [header, ...rows].join('\r\n') + '\r\n';
}

/** Human box label (e.g. "Rents") for a MISC box code — sourced from box-classify. */
export function miscBoxLabel(code: MiscBoxCode): string {
  return BOX_META[code].label;
}

/** IRS printed box number (e.g. "10") for a MISC box code. */
export function miscBoxNumber(code: MiscBoxCode): string {
  return BOX_META[code].box;
}
