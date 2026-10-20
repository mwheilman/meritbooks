/**
 * Deterministic manufacturer-credit matcher (the rule layer of FPB §5 A3) — pure.
 * The AI matcher (D2) proposes fuzzy pairs on top; this layer owns the exact rules and
 * the auto-settle eligibility test, which is deliberately narrow:
 *   auto-settle ONLY when claim # matches exactly AND amount = the claim's open amount
 *   AND confidence ≥ the client's threshold — never for short-pays or rejections.
 */

import { normalizeRef } from './statement-match';

export interface OemLineIn {
  id: string;
  line_type: string;
  reference: string | null;
  serial_number: string | null;
  amount_cents: number;
}

export interface OpenClaim {
  kind: 'WARRANTY' | 'INCENTIVE';
  id: string;
  /** oem_claim_number for warranty, claim_reference for incentives. */
  reference: string | null;
  serial_number: string | null;
  openCents: number;
}

export type OemMatchMethod = 'CLAIM_NUMBER' | 'CLAIM_NUMBER_SHORT' | 'SERIAL_AMOUNT';

export interface OemProposal {
  lineId: string;
  claimKind: 'WARRANTY' | 'INCENTIVE';
  claimId: string;
  method: OemMatchMethod;
  confidenceBps: number;
  /** Credit is less than the open amount — a short-pay a human must resolve. */
  shortPayCents: number;
  autoSettleEligible: boolean;
}

const CONFIDENCE: Record<OemMatchMethod, number> = {
  CLAIM_NUMBER: 10_000,
  CLAIM_NUMBER_SHORT: 9_000,
  SERIAL_AMOUNT: 8_500,
};

export function matchOemCredits(input: { lines: OemLineIn[]; claims: OpenClaim[]; autoMinConfidenceBps: number }): OemProposal[] {
  const used = new Set<string>();
  const out: OemProposal[] = [];
  for (const l of input.lines) {
    const kind = l.line_type === 'WARRANTY_CREDIT' ? 'WARRANTY' : l.line_type === 'INCENTIVE_CREDIT' ? 'INCENTIVE' : null;
    if (!kind || l.amount_cents <= 0) continue;
    const pool = input.claims.filter((c) => c.kind === kind && !used.has(`${c.kind}:${c.id}`) && c.openCents > 0);
    const ref = normalizeRef(l.reference);
    let claim: OpenClaim | undefined;
    let method: OemMatchMethod | null = null;
    if (ref) {
      claim = pool.find((c) => c.reference && normalizeRef(c.reference) === ref);
      if (claim) method = l.amount_cents === claim.openCents ? 'CLAIM_NUMBER' : 'CLAIM_NUMBER_SHORT';
    }
    if (!claim && l.serial_number) {
      const s = normalizeRef(l.serial_number);
      claim = pool.find((c) => c.serial_number && normalizeRef(c.serial_number) === s && c.openCents === l.amount_cents);
      if (claim) method = 'SERIAL_AMOUNT';
    }
    if (!claim || !method) continue;
    if (l.amount_cents > claim.openCents) continue; // over-credit: never auto-pair
    used.add(`${claim.kind}:${claim.id}`);
    const confidence = CONFIDENCE[method];
    out.push({
      lineId: l.id,
      claimKind: claim.kind,
      claimId: claim.id,
      method,
      confidenceBps: confidence,
      shortPayCents: claim.openCents - l.amount_cents,
      autoSettleEligible: method === 'CLAIM_NUMBER' && confidence >= input.autoMinConfidenceBps,
    });
  }
  return out;
}
