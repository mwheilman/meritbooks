/**
 * Server-side enforcement helpers over a GovernanceDecision. A report / metric API runs
 * every figure it is about to return through these — hidden months and excluded or
 * out-of-scope companies are DROPPED, never just greyed out in the UI. PURE.
 */

import type { GovernanceDecision, PeriodKey } from './types';

/** May (month, company) figures be returned under this decision? */
export function isShown(decision: GovernanceDecision, key: PeriodKey, locationId: string): boolean {
  const ids = decision.locationsByPeriod[key];
  return !!ids && ids.includes(locationId);
}

/**
 * Keep only rows whose (month, company) the decision shows. `pick` maps a row to its month
 * key ('YYYY-MM') and company id. Rows that cannot be attributed (null) are dropped — fail
 * closed.
 */
export function filterByGovernance<T>(
  rows: readonly T[],
  decision: GovernanceDecision,
  pick: (row: T) => { periodKey: PeriodKey | null; locationId: string | null },
): T[] {
  return rows.filter((r) => {
    const { periodKey, locationId } = pick(r);
    if (!periodKey || !locationId) return false;
    return isShown(decision, periodKey, locationId);
  });
}

/** A request for a month the caller may not see. Routes map this to 403 with the reason. */
export class GovernanceDeniedError extends Error {
  readonly status = 403;
  readonly code = 'NOT_RELEASED';
  constructor(
    message: string,
    readonly periodKeys: PeriodKey[],
  ) {
    super(message);
    this.name = 'GovernanceDeniedError';
  }
}

/**
 * For single-period surfaces (a statement "as of" one month, an export): throw unless every
 * requested month is shown. Multi-month views should filter instead.
 */
export function assertShown(decision: GovernanceDecision, keys: PeriodKey[]): void {
  const denied = keys.filter((k) => !decision.shownPeriodKeys.includes(k));
  if (denied.length) {
    throw new GovernanceDeniedError(
      `These months are not released for your audience: ${denied.join(', ')}`,
      denied,
    );
  }
}
