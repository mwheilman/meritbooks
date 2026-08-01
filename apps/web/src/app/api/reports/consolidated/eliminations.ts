/**
 * Consolidation eliminations (GATE 11a — the moat).
 *
 * Pure, deterministic netting of intercompany / interdepartmental activity for a
 * consolidated statement. Extracted from the route so it is unit-testable off the
 * database (the route feeds it aggregated account rows).
 *
 * Canon (CANON-ANCHOR §5; Master Doc II.4; migration 015): accounts flagged
 * `is_eliminating` (the interdepartmental Services Revenue / Cost accounts, and
 * the intercompany AR/AP positions) must NET TO ZERO at the group roll-up so the
 * consolidated revenue / expense / net income are unaffected by internal
 * activity — while genuine third-party costs (booked on non-eliminating accounts)
 * remain. Each eliminating account is netted to zero individually: the removed
 * amount is the account's own group total, surfaced as an explicit eliminations
 * figure the auditor can inspect. Per-entity values are preserved so a reader can
 * still see the internal activity that was eliminated.
 */

export interface ConsolAccountInput {
  accountNumber: string;
  accountName: string;
  accountType: string;
  isEliminating: boolean;
  /** Net amount per location, already signed by the caller (revenue positive on credit). */
  byLocation: Record<string, number>;
}

export interface ConsolAccountOutput extends ConsolAccountInput {
  /** Group total before eliminations (sum across entities). */
  grossCents: number;
  /** Amount removed at consolidation (0 for non-eliminating accounts). */
  eliminationCents: number;
  /** Net after eliminations — 0 for an eliminating account when netting is applied. */
  consolidatedCents: number;
}

export interface EliminationResult {
  accounts: ConsolAccountOutput[];
  /** Sum of all elimination adjustments (the "Eliminations" column total). */
  totalEliminationCents: number;
}

/**
 * Apply per-account elimination netting.
 *
 * @param accounts aggregated account rows (each with per-entity net amounts)
 * @param eliminate when false, eliminations are reported as 0 (pass-through view)
 */
export function applyEliminations(
  accounts: ConsolAccountInput[],
  eliminate: boolean
): EliminationResult {
  let totalEliminationCents = 0;
  const out: ConsolAccountOutput[] = accounts.map((a) => {
    const grossCents = Object.values(a.byLocation).reduce((s, v) => s + v, 0);
    const eliminationCents = eliminate && a.isEliminating ? -grossCents : 0;
    totalEliminationCents += eliminationCents;
    return {
      ...a,
      grossCents,
      eliminationCents,
      consolidatedCents: grossCents + eliminationCents,
    };
  });
  return { accounts: out, totalEliminationCents };
}

/**
 * Sum the post-elimination consolidated balance of every eliminating account.
 * Must be exactly 0 once netting is applied (the correctness gate, AC5.1).
 */
export function eliminatingResidualCents(result: EliminationResult): number {
  return result.accounts
    .filter((a) => a.isEliminating)
    .reduce((s, a) => s + a.consolidatedCents, 0);
}

/**
 * Consolidated net income from the post-elimination rows, using the route's sign
 * convention (REVENUE and OTHER_INCOME are stored positive-on-credit; COGS/OPEX/
 * OTHER_EXPENSE positive-on-debit). Revenue less cost.
 */
export function consolidatedNetIncomeCents(result: EliminationResult): number {
  let revenue = 0;
  let cost = 0;
  for (const a of result.accounts) {
    if (a.accountType === 'REVENUE') revenue += a.consolidatedCents;
    else cost += a.consolidatedCents; // COGS / OPEX / OTHER (net expense)
  }
  return revenue - cost;
}
