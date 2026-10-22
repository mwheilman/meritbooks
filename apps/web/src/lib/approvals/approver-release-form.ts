/**
 * Settings → Approvals → Conflict rules → "Who can release an approved payment"
 * (owner decision, mig 174). Pure form logic for the three-choice setting, shared by
 * the client component and its tests. Money is bigint-style integer cents — the dollar
 * text is parsed with string arithmetic, never floating point.
 */

import type { ApproverReleaseChoice, ApproverReleasePolicy } from '@/lib/rbac/sod';

/** Same ceiling as the API ($1B). */
export const APPROVER_RELEASE_MAX_CENTS = 100_000_000_000;

export const APPROVER_RELEASE_OPTIONS: ReadonlyArray<{ value: ApproverReleaseChoice; label: string; help: string }> = [
  {
    value: 'off',
    label: 'Off',
    help: 'The person who approved a payment can never release it. A second person always releases.',
  },
  {
    value: 'any',
    label: 'On, any amount',
    help: 'The person who approved a payment may also release it, whatever the amount.',
  },
  {
    value: 'up_to',
    label: 'On, up to an amount you set',
    help: 'The approver may release payments up to your limit. Above it, a second person must release.',
  },
];

/** "5,000", "$5000.5", "5000.50" → cents. null when it isn't a plain positive dollar amount. */
export function parseDollarsToCents(input: string): number | null {
  const t = input.trim().replace(/^\$\s*/, '');
  const m = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  const whole = Number(m[1].replace(/,/g, ''));
  const frac = m[2] ? Number(m[2].padEnd(2, '0')) : 0;
  if (!Number.isSafeInteger(whole)) return null;
  const cents = whole * 100 + frac;
  return Number.isSafeInteger(cents) ? cents : null;
}

/** cents → "5000" / "5000.50" for the input box (no grouping, so it re-parses). */
export function centsToInput(cents: number | null): string {
  if (cents == null) return '';
  const whole = Math.trunc(cents / 100);
  const frac = Math.abs(cents % 100);
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, '0')}`;
}

export type ApproverReleaseFormResult =
  | { ok: true; policy: ApproverReleasePolicy }
  | { ok: false; error: string };

export function validateApproverReleaseForm(choice: ApproverReleaseChoice, amount: string): ApproverReleaseFormResult {
  if (choice !== 'up_to') return { ok: true, policy: { choice, maxCents: null } };
  if (amount.trim() === '') return { ok: false, error: 'Enter the most an approver may also release.' };
  const cents = parseDollarsToCents(amount);
  if (cents == null) return { ok: false, error: 'Enter a dollar amount, like 5,000 or 5000.00.' };
  if (cents <= 0) return { ok: false, error: 'Enter an amount greater than $0.' };
  if (cents > APPROVER_RELEASE_MAX_CENTS) return { ok: false, error: 'Enter an amount of $1,000,000,000 or less.' };
  return { ok: true, policy: { choice: 'up_to', maxCents: cents } };
}

export function samePolicy(a: ApproverReleasePolicy, b: ApproverReleasePolicy): boolean {
  return a.choice === b.choice && (a.choice !== 'up_to' || a.maxCents === b.maxCents);
}

/** The confirmation dialog for a change from → to. */
export function approverReleaseConfirmation(
  to: ApproverReleasePolicy,
  money: (cents: number) => string,
): { title: string; body: string; confirmLabel: string } {
  const payroll = ' Payroll always needs a second person, and whoever prepared a payment can never release it.';
  if (to.choice === 'off') {
    return {
      title: 'Require a second person to release every payment?',
      body: `Approved payments will need someone other than their approver to release them.${payroll}`,
      confirmLabel: 'Turn off',
    };
  }
  if (to.choice === 'any') {
    return {
      title: 'Let approvers release their own payments?',
      body: `The person who approves a payment will also be able to release it, for any amount. This shows as a standing exception in access reviews.${payroll}`,
      confirmLabel: 'Allow any amount',
    };
  }
  const limit = money(to.maxCents ?? 0);
  return {
    title: `Let approvers release payments up to ${limit}?`,
    body: `The person who approves a payment of ${limit} or less will also be able to release it. Anything over ${limit} needs a second person to release.${payroll}`,
    confirmLabel: `Allow up to ${limit}`,
  };
}
