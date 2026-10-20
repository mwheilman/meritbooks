/**
 * Evidence must sum to the claim (§7.8, §8.4 "totals tie"). Pure, so the rule
 * is unit-tested and enforced identically on server and client.
 */
import { assertCents, count, money, type MoneyOptions } from '../format';

export interface EvidenceRow {
  label: string;
  /** Integer cents (unit 'money') or an integer count (unit 'count'). */
  value: number;
}

export class EvidenceMismatchError extends Error {
  constructor(
    public readonly expected: number,
    public readonly actual: number,
    claim: string,
  ) {
    super(`Evidence for "${claim}" does not tie: rows sum to ${actual}, total says ${expected} (off by ${expected - actual}).`);
    this.name = 'EvidenceMismatchError';
  }
}

/** Sum of the rows (integers only). */
export function evidenceSum(rows: ReadonlyArray<EvidenceRow>): number {
  let s = 0;
  for (const r of rows) s += assertCents(r.value);
  return s;
}

/** Throws EvidenceMismatchError unless the rows sum exactly to `total`. Returns the sum. */
export function assertEvidenceTies(rows: ReadonlyArray<EvidenceRow>, total: number, claim = 'evidence'): number {
  const sum = evidenceSum(rows);
  if (sum !== assertCents(total)) throw new EvidenceMismatchError(total, sum, claim);
  return sum;
}

/** Format one evidence value for its unit. */
export function formatEvidenceValue(value: number, unit: 'money' | 'count', moneyOpts?: MoneyOptions): string {
  if (unit === 'count') return count(value);
  return money(value, moneyOpts);
}
