/**
 * Reporting-basis OVERLAY (pure, I/O-free).
 *
 * MeritBooks keeps the GAAP/accrual general ledger as the ONE book of record (CANON
 * GATE 2). This module NEVER touches the ledger or the posting engine. It takes the
 * OUTPUT of a GAAP statement (a trial balance / P&L / BS, already computed the normal
 * way) and LAYERS per-account presentation adjustments on top of it to PRESENT the same
 * figures on a TAX, CASH, or CUSTOM basis. The rows it consumes come from
 * `public.reporting_basis_adjustments` (migration 147) — they are report-presentation
 * deltas, not journal entries, and they never post.
 *
 * Sign convention (the single contract everything else obeys):
 *   `amountCents` is a SIGNED delta in cents applied to the account's NATURAL
 *   (normal-balance-positive) amount as it already appears on the statement.
 *     +  increases the account's natural magnitude (more expense, more revenue, …)
 *     −  decreases it.
 *   That is the SAME sign space the P&L / BS / TB renderers already use, so overlaying
 *   is a straight per-account addition on screen — no re-derivation of GAAP math.
 *
 * Balancing invariant:
 *   A GAAP trial balance balances because Σ(debits − credits) = 0 across all accounts.
 *   Converting each natural delta to DEBIT-POSITIVE space (debit-normal: +Δ, credit-normal:
 *   −Δ) and summing gives the net effect on that identity. A basis PRESENTATION is only
 *   internally consistent when that sum is zero — i.e. every income/expense adjustment is
 *   matched by an offsetting balance-sheet (usually equity / deferred-tax) adjustment. We
 *   compute this and surface an imbalance rather than silently forcing a plug.
 */

export type ReportingBasis = 'TAX' | 'CASH' | 'CUSTOM';
export type AdjustmentType = 'TIMING' | 'PERMANENT' | 'RECLASS';
export type NormalBalance = 'DEBIT' | 'CREDIT';

/** One report-presentation adjustment (a signed NATURAL delta on one account). */
export interface BasisAdjustment {
  id?: string;
  accountId: string;
  /** SIGNED natural delta in cents (see module header for the convention). */
  amountCents: number;
  description?: string | null;
  adjustmentType?: AdjustmentType | null;
  source?: string | null;
}

/**
 * A GAAP account balance to overlay onto — natural-signed (normal-balance positive),
 * e.g. `v_trial_balance.net_balance`.
 */
export interface GaapAccountBalance {
  accountId: string;
  accountNumber: string;
  accountName: string;
  normalBalance: NormalBalance;
  /** natural-signed balance in cents (normal-balance positive). */
  naturalCents: number;
}

/** Minimal metadata for an account that appears ONLY in the adjustments (no GAAP activity). */
export interface AccountMeta {
  accountNumber: string;
  accountName: string;
  normalBalance: NormalBalance;
}

export interface AdjustedAccountRow {
  accountId: string;
  accountNumber: string;
  accountName: string;
  normalBalance: NormalBalance;
  /** natural-signed GAAP balance. */
  gaapCents: number;
  /** natural-signed aggregated adjustment applied to this account. */
  adjustmentCents: number;
  /** natural-signed adjusted balance (gaap + adjustment). */
  adjustedCents: number;
}

export interface BasisOverlayResult {
  rows: AdjustedAccountRow[];
  /**
   * Σ of every adjustment converted to DEBIT-POSITIVE space. 0 ⟺ the adjusted trial
   * balance still balances (Σ debits = Σ credits). Non-zero = the presentation is off by
   * this much and should be flagged, not hidden.
   */
  netDebitPositiveCents: number;
  /** true when the adjustments keep the trial balance in balance. */
  balances: boolean;
  /** count of non-zero adjustment entries applied. */
  adjustmentCount: number;
}

/** Convert a NATURAL delta to a DEBIT-POSITIVE (debits − credits) delta for an account. */
export function toDebitPositive(naturalDelta: number, normalBalance: NormalBalance): number {
  return normalBalance === 'DEBIT' ? naturalDelta : -naturalDelta;
}

/** Aggregated, itemized view of the adjustments for one account (for drill / audit). */
export interface AccountAdjustmentSummary {
  accountId: string;
  /** aggregated signed natural delta for the account. */
  naturalCents: number;
  /** the individual adjustment rows that make it up (auditable provenance). */
  items: BasisAdjustment[];
}

/**
 * Group the raw adjustments by account so a renderer can (a) add one natural delta per
 * account and (b) itemize the components for a drill-down. Pure.
 */
export function summarizeByAccount(
  adjustments: readonly BasisAdjustment[],
): Map<string, AccountAdjustmentSummary> {
  const byAccount = new Map<string, AccountAdjustmentSummary>();
  for (const adj of adjustments) {
    const amt = Math.round(adj.amountCents);
    if (!Number.isFinite(amt)) continue;
    let s = byAccount.get(adj.accountId);
    if (!s) {
      s = { accountId: adj.accountId, naturalCents: 0, items: [] };
      byAccount.set(adj.accountId, s);
    }
    s.naturalCents += amt;
    s.items.push(adj);
  }
  return byAccount;
}

/**
 * Layer a set of basis adjustments onto a GAAP account-balance set. Pure — with an empty
 * `adjustments` array the result mirrors GAAP exactly (every adjustedCents === gaapCents,
 * balances === true, adjustmentCount === 0), which is what makes "Accrual (GAAP)" provably
 * the untouched default.
 */
export function applyBasisOverlay(
  gaap: readonly GaapAccountBalance[],
  adjustments: readonly BasisAdjustment[],
  accountMeta?: ReadonlyMap<string, AccountMeta>,
): BasisOverlayResult {
  const byId = new Map<string, AdjustedAccountRow>();
  for (const g of gaap) {
    const gaapCents = Math.round(g.naturalCents);
    byId.set(g.accountId, {
      accountId: g.accountId,
      accountNumber: g.accountNumber,
      accountName: g.accountName,
      normalBalance: g.normalBalance,
      gaapCents,
      adjustmentCents: 0,
      adjustedCents: gaapCents,
    });
  }

  let adjustmentCount = 0;
  for (const adj of adjustments) {
    const amt = Math.round(adj.amountCents);
    if (!Number.isFinite(amt) || amt === 0) continue;
    adjustmentCount += 1;
    let row = byId.get(adj.accountId);
    if (!row) {
      const meta = accountMeta?.get(adj.accountId);
      row = {
        accountId: adj.accountId,
        accountNumber: meta?.accountNumber ?? '',
        accountName: meta?.accountName ?? adj.accountId,
        normalBalance: meta?.normalBalance ?? 'DEBIT',
        gaapCents: 0,
        adjustmentCents: 0,
        adjustedCents: 0,
      };
      byId.set(adj.accountId, row);
    }
    row.adjustmentCents += amt;
    row.adjustedCents = row.gaapCents + row.adjustmentCents;
  }

  let netDebitPositiveCents = 0;
  for (const row of byId.values()) {
    netDebitPositiveCents += toDebitPositive(row.adjustmentCents, row.normalBalance);
  }

  const rows = Array.from(byId.values()).sort((a, b) =>
    a.accountNumber.localeCompare(b.accountNumber),
  );

  return {
    rows,
    netDebitPositiveCents,
    balances: netDebitPositiveCents === 0,
    adjustmentCount,
  };
}

/** Human label for a basis (used in banners / export basis labels). */
export function basisPresentationLabel(basis: ReportingBasis, customLabel?: string | null): string {
  if (basis === 'TAX') return 'Tax basis';
  if (basis === 'CASH') return 'Cash basis';
  return customLabel && customLabel.trim() ? customLabel.trim() : 'Custom basis';
}
