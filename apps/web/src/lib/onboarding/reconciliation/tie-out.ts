/**
 * Extended go-live tie-out — subledger→control & WIP→GL ties (PURE, deterministic).
 *
 * The base conversion gate (lib/onboarding/conversion.ts) proves the opening trial
 * balance is BALANCED (debits == credits) and that the balance-sheet identity holds.
 * That is necessary but not sufficient for an accountant to TRUST a conversion: a
 * trial balance can foot perfectly while the AR subledger detail disagrees with the
 * 1100 control, or the WIP schedule disagrees with the 1180/2410 contract accounts.
 * Those are exactly the errors that make a QuickBooks parallel-run diverge.
 *
 * This module adds the accuracy backbone the controller brief (ONBOARDING-DESIGN-SPEC
 * §4) calls for — additional HARD blocks before go-live:
 *   - Σ open AR by customer          = AR control (role AR_CONTROL / 1100) balance
 *   - Σ open AP by vendor            = AP control (role AP_CONTROL) balance
 *   - Retainage receivable / payable = their control accounts (when present)
 *   - Σ costs-to-date                = WIP / job-cost asset (role JOB_WIP)
 *   - Σ unbilled                     = contract asset (role UNBILLED_RECEIVABLE / 1180)
 *   - Σ billings-in-excess           = contract liability (role DEFERRED_REVENUE / 2410)
 *
 * INVARIANT: these are pure functions over integer CENTS. They never resolve an
 * account number — the CALLER resolves each control account BY ROLE (account-roles.ts)
 * and passes the resolved control balance in cents. No hard-coded account numbers live
 * here, so a tenant that remapped its COA is handled correctly. The sibling test file
 * is the correctness guarantee.
 */

import type { AccountRoleKey } from '@/lib/posting/account-roles';

/** One subledger/WIP stream tied to its GL control account. All cents. */
export interface SubledgerControlTie {
  /** Stable key (e.g. 'AR', 'AP', 'RETAINAGE_REC', 'UNBILLED'). */
  key: string;
  /** Human label for the report / blocker message. */
  label: string;
  /** The control account role the caller resolved this against (no hard-coded #). */
  controlRole: AccountRoleKey;
  /** Σ of the subledger/WIP detail, cents (magnitude — normal-balance positive). */
  subledgerCents: number;
  /** The resolved control account's balance, cents (same orientation as subledger). */
  controlCents: number;
  /** subledger − control; zero when the detail foots to its control. */
  varianceCents: number;
  /** True when variance is exactly zero. */
  ties: boolean;
}

/**
 * Tie one subledger/WIP stream to its control account. Pure and total. Inputs are
 * cents magnitudes in the account's NORMAL orientation (assets debit-positive,
 * liabilities credit-positive) — the caller normalizes both sides the same way so a
 * sign convention can never masquerade as a variance.
 */
export function tieSubledgerToControl(
  key: string,
  label: string,
  controlRole: AccountRoleKey,
  subledgerCents: number,
  controlCents: number,
): SubledgerControlTie {
  const sub = Math.round(subledgerCents || 0);
  const ctl = Math.round(controlCents || 0);
  const varianceCents = sub - ctl;
  return { key, label, controlRole, subledgerCents: sub, controlCents: ctl, varianceCents, ties: varianceCents === 0 };
}

/**
 * Turn any non-tying subledger/WIP tie into a blocking reason string. Empty ⇒ every
 * subledger foots to its control (go-live may proceed on this axis). These are HARD
 * blocks — the spec lists them among the tie-out gate's non-negotiable checks, so
 * there is no acknowledgment bypass (unlike the mid-year P&L identity gate).
 */
export function subledgerControlBlockers(ties: SubledgerControlTie[]): string[] {
  const out: string[] = [];
  for (const t of ties) {
    if (t.ties) continue;
    const dir = t.varianceCents > 0 ? 'exceeds' : 'is short of';
    out.push(
      `${t.label} detail (${t.subledgerCents} cents) ${dir} its control account "${t.controlRole}" ` +
      `(${t.controlCents} cents) by ${Math.abs(t.varianceCents)} cents. ` +
      `Reconcile the subledger detail to the control before go-live.`,
    );
  }
  return out;
}

/** True when every tie foots (variance zero). Empty list ⇒ trivially true. */
export function allSubledgersTie(ties: SubledgerControlTie[]): boolean {
  return ties.every((t) => t.ties);
}
