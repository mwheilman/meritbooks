/**
 * AP 3-WAY MATCH — pure, deterministic, unit-tested (GATE 11b, migration 080).
 *
 * The classic AP control: before a bill is paid, reconcile three independent
 * documents for the same procurement —
 *   1. the PURCHASE ORDER  (what we agreed to buy: ordered qty × unit cost),
 *   2. the GOODS RECEIPT   (what actually arrived: received qty),
 *   3. the VENDOR BILL     (what we are being charged: billed qty × unit cost).
 *
 * A line PASSES only when the money and quantities line up along the canonical
 * inequality  billed ≤ received ≤ ordered  AND the billed unit price is within the
 * tolerance band of the PO unit price. Anything else is an EXCEPTION with an
 * itemized, dollar-quantified reason — which the caller surfaces to a HUMAN via the
 * ai_decisions → /exceptions rail. This module NEVER moves money, posts, or pays; it
 * DECIDES a verdict (canon §3: AI/engine proposes facts; a human approves).
 *
 * All money is bigint cents. Quantities may be fractional (numeric). The function is
 * I/O-free — the orchestrating route does the RLS-scoped reads/writes.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Inputs
// ─────────────────────────────────────────────────────────────────────────────

/** A purchase-order line + its cumulative received quantity. */
export interface PoLineInput {
  id: string;
  description: string | null;
  /** GL account this line posts to when billed (public.accounts). */
  accountId: string | null;
  /** Optional item master (core.items). Preferred match key when present. */
  itemId: string | null;
  /** Ordered quantity (numeric, may be fractional). */
  orderedQty: number;
  /** Agreed unit cost, bigint cents. */
  unitCostCents: number;
  /** Total received against this line across all goods receipts. */
  receivedQty: number;
}

/** A vendor-bill line being matched to the PO. */
export interface BillLineInput {
  id: string;
  description: string | null;
  accountId: string | null;
  itemId: string | null;
  /** Quantity billed (numeric). */
  billedQty: number;
  /** Unit cost charged, bigint cents. */
  unitCostCents: number;
  /** Extended amount billed, bigint cents (authoritative money figure). */
  amountCents: number;
}

export interface ThreeWayMatchTolerance {
  /** Price tolerance as a fraction of PO unit cost (0.05 = 5%). Default 5%. */
  pricePct: number;
  /** Absolute per-unit price grace, bigint cents (covers rounding on cheap items). */
  priceAbsCents: number;
  /** Quantity epsilon — differences at/under this are treated as zero. */
  qtyEpsilon: number;
}

export const DEFAULT_TOLERANCE: ThreeWayMatchTolerance = {
  pricePct: 0.05,
  priceAbsCents: 1,
  qtyEpsilon: 0.0001,
};

export interface ThreeWayMatchInput {
  poLines: PoLineInput[];
  billLines: BillLineInput[];
  tolerance?: Partial<ThreeWayMatchTolerance>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Output
// ─────────────────────────────────────────────────────────────────────────────

export type MatchFlag =
  | 'OVER_BILL' //     billed qty > received qty (charged for more than arrived)
  | 'OVER_RECEIPT' //  received qty > ordered qty (more arrived than ordered)
  | 'UNDER_RECEIPT' // received qty < ordered qty (informational; partial delivery)
  | 'PRICE_VARIANCE' // billed unit cost outside PO tolerance
  | 'UNMATCHED_BILL_LINE' // bill line has no corresponding PO line
  | 'QTY_NOT_YET_RECEIVED'; // billed against goods not yet receipted

export type LineVerdict = 'PASS' | 'EXCEPTION';

export interface LineMatchResult {
  poLineId: string | null;
  billLineId: string | null;
  description: string | null;
  orderedQty: number;
  receivedQty: number;
  billedQty: number;
  poUnitCostCents: number;
  billUnitCostCents: number;
  billedAmountCents: number;
  /** Signed price variance per unit, bigint cents (bill − PO). */
  priceVarianceCents: number;
  flags: MatchFlag[];
  verdict: LineVerdict;
  reason: string;
}

export type MatchVerdict = 'PASS' | 'EXCEPTION';

export interface ThreeWayMatchResult {
  verdict: MatchVerdict;
  lines: LineMatchResult[];
  flags: MatchFlag[]; // union of all line flags (deduped)
  /** Total dollar exposure of the exceptions (over-bill + price variance), cents. */
  amountAtRiskCents: number;
  /** Ordered / received / billed value roll-ups, bigint cents. */
  totals: {
    orderedCents: number;
    receivedCents: number;
    billedCents: number;
  };
  reasons: string[]; // one line per exception, human-readable
  summary: string; // one-line headline for the exception title
  toleranceUsed: ThreeWayMatchTolerance;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function fmtMoney(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  return `${sign}$${(abs / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtQty(q: number): string {
  return Number.isInteger(q) ? String(q) : q.toFixed(2);
}

/** Match a bill line to at most one PO line: prefer item_id, else account_id +
 *  best description overlap. Returns the index into poLines, or -1. Each PO line is
 *  consumed at most once (greedy, stable). */
function pairLines(
  poLines: PoLineInput[],
  billLines: BillLineInput[],
): Array<{ bill: BillLineInput; po: PoLineInput | null }> {
  const used = new Set<number>();
  const pairs: Array<{ bill: BillLineInput; po: PoLineInput | null }> = [];

  const norm = (s: string | null) => (s ?? '').trim().toLowerCase();

  for (const bill of billLines) {
    let bestIdx = -1;
    let bestScore = -1;

    for (let i = 0; i < poLines.length; i++) {
      if (used.has(i)) continue;
      const po = poLines[i];
      let score = -1;

      if (bill.itemId && po.itemId && bill.itemId === po.itemId) {
        score = 100;
      } else if (bill.accountId && po.accountId && bill.accountId === po.accountId) {
        // Same account — break ties by description similarity.
        score = 50;
        const bd = norm(bill.description);
        const pd = norm(po.description);
        if (bd && pd && (bd === pd || bd.includes(pd) || pd.includes(bd))) score += 10;
      } else if (
        bill.description &&
        po.description &&
        norm(bill.description) === norm(po.description)
      ) {
        score = 30;
      }

      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0 && bestScore >= 0) {
      used.add(bestIdx);
      pairs.push({ bill, po: poLines[bestIdx] });
    } else {
      pairs.push({ bill, po: null });
    }
  }

  return pairs;
}

// ─────────────────────────────────────────────────────────────────────────────
// The engine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the 3-way match. Pure — no I/O. The verdict is EXCEPTION if ANY bill line
 * fails; otherwise PASS. UNDER_RECEIPT alone (a partial delivery being billed only
 * for what arrived) is informational and does NOT fail the match.
 */
export function runThreeWayMatch(input: ThreeWayMatchInput): ThreeWayMatchResult {
  const tolerance: ThreeWayMatchTolerance = {
    ...DEFAULT_TOLERANCE,
    ...(input.tolerance ?? {}),
  };
  const { qtyEpsilon, pricePct, priceAbsCents } = tolerance;

  const pairs = pairLines(input.poLines, input.billLines);
  const lines: LineMatchResult[] = [];
  let amountAtRiskCents = 0;

  for (const { bill, po } of pairs) {
    const flags: MatchFlag[] = [];
    const reasons: string[] = [];

    // ── Unmatched bill line: nothing on the PO corresponds to it. ──
    if (!po) {
      const reason = `Billed line "${bill.description ?? bill.id}" (${fmtMoney(
        bill.amountCents,
      )}) has no matching purchase-order line.`;
      amountAtRiskCents += Math.max(0, bill.amountCents);
      lines.push({
        poLineId: null,
        billLineId: bill.id,
        description: bill.description,
        orderedQty: 0,
        receivedQty: 0,
        billedQty: bill.billedQty,
        poUnitCostCents: 0,
        billUnitCostCents: bill.unitCostCents,
        billedAmountCents: bill.amountCents,
        priceVarianceCents: 0,
        flags: ['UNMATCHED_BILL_LINE'],
        verdict: 'EXCEPTION',
        reason,
      });
      continue;
    }

    // ── Quantity checks along  billed ≤ received ≤ ordered. ──
    const overBillQty = bill.billedQty - po.receivedQty;
    if (overBillQty > qtyEpsilon) {
      // Charged for more than has been received.
      if (po.receivedQty <= qtyEpsilon) {
        flags.push('QTY_NOT_YET_RECEIVED');
        reasons.push(
          `Billed ${fmtQty(bill.billedQty)} but nothing has been received yet.`,
        );
      } else {
        flags.push('OVER_BILL');
        reasons.push(
          `Billed ${fmtQty(bill.billedQty)} exceeds received ${fmtQty(
            po.receivedQty,
          )} (over-billed ${fmtQty(overBillQty)}).`,
        );
      }
      amountAtRiskCents += Math.max(0, Math.round(overBillQty * po.unitCostCents));
    }

    const overReceiptQty = po.receivedQty - po.orderedQty;
    if (overReceiptQty > qtyEpsilon) {
      flags.push('OVER_RECEIPT');
      reasons.push(
        `Received ${fmtQty(po.receivedQty)} exceeds ordered ${fmtQty(
          po.orderedQty,
        )} (over-receipt ${fmtQty(overReceiptQty)}).`,
      );
    } else if (po.orderedQty - po.receivedQty > qtyEpsilon) {
      // Informational only — a partial delivery.
      flags.push('UNDER_RECEIPT');
    }

    // ── Price check: billed unit cost vs PO unit cost within tolerance. ──
    const priceVarianceCents = bill.unitCostCents - po.unitCostCents;
    const allowed = Math.max(
      priceAbsCents,
      Math.round(Math.abs(po.unitCostCents) * pricePct),
    );
    if (Math.abs(priceVarianceCents) > allowed) {
      flags.push('PRICE_VARIANCE');
      const dir = priceVarianceCents > 0 ? 'above' : 'below';
      reasons.push(
        `Billed unit price ${fmtMoney(bill.unitCostCents)} is ${fmtMoney(
          Math.abs(priceVarianceCents),
        )} ${dir} the PO price ${fmtMoney(po.unitCostCents)} (tolerance ${(
          pricePct * 100
        ).toFixed(1)}%).`,
      );
      // $ at risk from price = variance × billed qty (only the overcharge side).
      if (priceVarianceCents > 0) {
        amountAtRiskCents += Math.round(priceVarianceCents * Math.max(0, bill.billedQty));
      }
    }

    // UNDER_RECEIPT alone is not a failure. Real exception flags:
    const failing = flags.filter(
      (f) => f === 'OVER_BILL' || f === 'OVER_RECEIPT' || f === 'PRICE_VARIANCE' || f === 'QTY_NOT_YET_RECEIVED',
    );
    const verdict: LineVerdict = failing.length > 0 ? 'EXCEPTION' : 'PASS';

    lines.push({
      poLineId: po.id,
      billLineId: bill.id,
      description: bill.description ?? po.description,
      orderedQty: po.orderedQty,
      receivedQty: po.receivedQty,
      billedQty: bill.billedQty,
      poUnitCostCents: po.unitCostCents,
      billUnitCostCents: bill.unitCostCents,
      billedAmountCents: bill.amountCents,
      priceVarianceCents,
      flags,
      verdict,
      reason:
        verdict === 'PASS'
          ? 'Ordered, received and billed agree within tolerance.'
          : reasons.join(' '),
    });
  }

  const allFlags = Array.from(new Set(lines.flatMap((l) => l.flags)));
  const exceptionLines = lines.filter((l) => l.verdict === 'EXCEPTION');
  const verdict: MatchVerdict = exceptionLines.length > 0 ? 'EXCEPTION' : 'PASS';

  const totals = {
    orderedCents: input.poLines.reduce(
      (s, l) => s + Math.round(l.orderedQty * l.unitCostCents),
      0,
    ),
    receivedCents: input.poLines.reduce(
      (s, l) => s + Math.round(l.receivedQty * l.unitCostCents),
      0,
    ),
    billedCents: input.billLines.reduce((s, l) => s + l.amountCents, 0),
  };

  const reasons = exceptionLines.map((l) => l.reason);
  const summary =
    verdict === 'PASS'
      ? `3-way match clean: ${fmtMoney(totals.billedCents)} billed reconciles to PO and receipts.`
      : `3-way match exception: ${exceptionLines.length} of ${lines.length} line(s) failed — ${fmtMoney(
          amountAtRiskCents,
        )} at risk.`;

  return {
    verdict,
    lines,
    flags: allFlags,
    amountAtRiskCents,
    totals,
    reasons,
    summary,
    toleranceUsed: tolerance,
  };
}

/** The ai_decisions feature key for a 3-way-match exception. */
export const THREE_WAY_MATCH_FEATURE = 'THREE_WAY_MATCH';

/** Clamp a 0..1 confidence into the numeric(5,4) range ai_decisions accepts. */
export function toMatchConfidence(score: number): number {
  const s = Number.isFinite(score) ? score : 0;
  return Math.max(0, Math.min(0.9999, Math.round(s * 10000) / 10000));
}
