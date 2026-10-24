/**
 * Card charges → cardholders → the chase decision. PURE (no I/O): the sync (chase.ts)
 * loads rows and hands them here, so every rule is unit-testable.
 *
 * Which bank lines are card charges:
 *   • any OUTFLOW (amount_cents < 0) on a CREDIT_CARD feed account, and
 *   • an outflow on any other account whose description carries an ASSIGNED card's
 *     last 4 ("DEBIT CARD 5512 SHELL OIL …") — a debit card on a checking account.
 * Never a charge: card payments / autopay / "thank you" lines, refunds and credits
 * (amount ≥ 0), and lines already settled against a bill (matched_bill_id).
 *
 * Who holds it (first that applies; an assignment must be active on the charge date):
 *   1. an assignment on the charge's account whose last 4 appears in the description;
 *   2. an assignment on the charge's account with no last 4 (the whole feed is one card);
 *   3. an assignment with no account whose last 4 equals the account mask or appears in
 *      the description.
 */

import type { ReceiptPolicy } from './policy';
import { receiptRequired } from './policy';
import type { CardAccount, CardAssignmentRow, ChargeState, ChargeTxn } from './types';

const PAYMENT_RE = /\b(autopay|auto[\s-]?pay|automatic payment|payment\s*(?:-|–)?\s*thank|thank you|online payment|payment received|epayment|card payment|balance transfer|interest charge|late fee reversal)\b/i;

/** A card payment / statement line, not a purchase. */
export function isCardPaymentLine(description: string): boolean {
  return PAYMENT_RE.test(description);
}

function lastFourIn(description: string, last4: string): boolean {
  // A standalone 4-digit group: "x5512", "*5512", "CARD 5512", "ending 5512" — not inside a longer number.
  const re = new RegExp(`(?:^|[^0-9])${last4}(?:[^0-9]|$)`);
  return re.test(description);
}

function activeOn(a: CardAssignmentRow, date: string): boolean {
  if (!a.active) return false;
  if (a.starts_on && date < a.starts_on) return false;
  if (a.ends_on && date > a.ends_on) return false;
  return true;
}

/** Is this bank line a card charge the chase should look at? */
export function isCardCharge(txn: ChargeTxn, account: CardAccount | undefined, assignments: ReadonlyArray<CardAssignmentRow>): boolean {
  if (txn.amount_cents >= 0) return false;
  if (txn.matched_bill_id) return false;
  if (isCardPaymentLine(txn.description)) return false;
  if (account?.account_type === 'CREDIT_CARD') return true;
  // Debit card on another account: only when an assignment names a last 4 that appears.
  return assignments.some(
    (a) => a.card_last4 && (a.bank_account_id == null || a.bank_account_id === txn.bank_account_id) && lastFourIn(txn.description, a.card_last4),
  );
}

/** The cardholder for a charge, or null. */
export function resolveCardholder(
  txn: Pick<ChargeTxn, 'bank_account_id' | 'description' | 'transaction_date' | 'location_id'>,
  account: Pick<CardAccount, 'account_mask'> | undefined,
  assignments: ReadonlyArray<CardAssignmentRow>,
): CardAssignmentRow | null {
  const live = assignments.filter((a) => activeOn(a, txn.transaction_date) && a.location_id === txn.location_id);
  const onAccount = live.filter((a) => a.bank_account_id === txn.bank_account_id);
  const byLast4 = onAccount.find((a) => a.card_last4 && lastFourIn(txn.description, a.card_last4));
  if (byLast4) return byLast4;
  const whole = onAccount.find((a) => !a.card_last4);
  if (whole) return whole;
  const mask = account?.account_mask?.replace(/\D/g, '').slice(-4) ?? null;
  const loose = live.find(
    (a) => a.bank_account_id == null && a.card_last4 && ((mask && a.card_last4 === mask) || lastFourIn(txn.description, a.card_last4)),
  );
  return loose ?? null;
}

export interface ChargeDecisionInput {
  txn: ChargeTxn;
  holder: CardAssignmentRow | null;
  policy: ReceiptPolicy;
  chaseOn: boolean;
  /** A receipt is already linked to this charge (any path). */
  hasReceipt: boolean;
  /** A person already said "not required" for this charge. */
  waived: boolean;
}

/** The chase state for one charge. */
export function decideChargeState(i: ChargeDecisionInput): ChargeState {
  if (i.hasReceipt || i.txn.matched_receipt_id) return 'matched';
  if (i.waived) return 'not_required';
  if (!receiptRequired(i.policy, i.txn.amount_cents)) return 'below_threshold';
  if (!i.holder) return 'no_cardholder';
  if (!i.chaseOn) return 'chase_off';
  if (i.holder.chase_opt_out) return 'opted_out';
  return 'needed';
}

const DAY_MS = 86_400_000;

function dateMs(d: string): number {
  return Date.parse(`${d}T00:00:00Z`);
}

/** Has the grace period passed (charge_date + grace_days ≤ today, UTC dates)? */
export function graceElapsed(chargeDate: string, graceDays: number, now: Date): boolean {
  return dateMs(chargeDate) + graceDays * DAY_MS <= now.getTime();
}

/** Is a charge still inside the chase window? */
export function insideWindow(chargeDate: string, windowDays: number, now: Date): boolean {
  return now.getTime() - dateMs(chargeDate) <= windowDays * DAY_MS;
}

/**
 * Should the sync OPEN a request for a needed charge now?
 *   • grace elapsed;
 *   • inside the chase window;
 *   • when chase was switched back on (resumedAt), only charges dated on/after the switch-on
 *     OR still inside the window — the window check already bounds that, so a re-enable
 *     never asks about anything older than the window (no burst).
 */
export function shouldOpenRequest(chargeDate: string, policy: Pick<ReceiptPolicy, 'graceDays' | 'chaseWindowDays'>, now: Date): boolean {
  return graceElapsed(chargeDate, policy.graceDays, now) && insideWindow(chargeDate, policy.chaseWindowDays, now);
}

/** Strip card-network noise so "SQ *BLUE BOTTLE #123 OAKLAND CA" reads "blue bottle". */
export function cleanMerchant(description: string): string {
  return description
    .replace(/^(?:sq|sqc|tst|pp|paypal|sp|py|pos|dd|ach|debit card purchase|debit card|card purchase|purchase|checkcard|chk card|visa|mc)\s*[*#:-]?\s*/i, '')
    .replace(/\b(?:x+|\*+)\d{4}\b/g, ' ')
    .replace(/#\s*\d+/g, ' ')
    .replace(/\b\d{3,}\b/g, ' ')
    .replace(/\s[A-Z]{2}\s*$/, ' ') // trailing US state in a feed line ("… OAKLAND CA")
    .replace(/[^a-z0-9&' ]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Display label for a charge's merchant (keeps the bank's casing, trims the noise). */
export function merchantLabel(description: string): string {
  const c = cleanMerchant(description);
  if (!c) return description.slice(0, 80);
  return c.replace(/\b\w/g, (m) => m.toUpperCase()).slice(0, 80);
}

// ── Card-feed receipt badge + charges that aged out of the chase window ─────────────

/** What the card feed shows in its receipt column for one line. */
export type CardLineReceiptStatus = 'MATCHED' | 'MISSING' | 'PENDING' | 'NOT_REQUIRED' | 'NOT_APPLICABLE';

/**
 * The receipt status of one card-feed line. Card payments / autopay / "thank you" lines,
 * refunds and credits (amount ≥ 0) are NOT purchases, so they never say "No receipt"
 * (`NOT_APPLICABLE`); a line settled against a bill has its document already.
 */
export function cardLineReceiptStatus(
  line: Pick<ChargeTxn, 'amount_cents' | 'description' | 'matched_receipt_id'> & { matched_bill_id?: string | null },
  chaseStatus: string | null,
): CardLineReceiptStatus {
  if (line.matched_receipt_id || chaseStatus === 'matched') return 'MATCHED';
  if (Number(line.amount_cents) >= 0 || isCardPaymentLine(line.description ?? '')) return 'NOT_APPLICABLE';
  if (line.matched_bill_id) return 'NOT_REQUIRED';
  if (chaseStatus === 'not_required' || chaseStatus === 'below_threshold') return 'NOT_REQUIRED';
  if (chaseStatus === 'requested') return 'PENDING';
  return 'MISSING';
}

/** Does this card-feed line still need a receipt? */
export function needsReceipt(status: CardLineReceiptStatus): boolean {
  return status === 'MISSING' || status === 'PENDING';
}

export interface OlderChargeInput {
  txns: ReadonlyArray<ChargeTxn>;
  accounts: ReadonlyMap<string, CardAccount>;
  assignments: ReadonlyArray<CardAssignmentRow>;
  /** Transactions the chase already tracks (any state) — counted on the board, not here. */
  tracked: ReadonlySet<string>;
  /** Transactions a receipt is already linked to. */
  withReceipt: ReadonlySet<string>;
  policyFor: (locationId: string) => Pick<ReceiptPolicy, 'chaseWindowDays' | 'receiptRequiredOverCents'>;
  now: Date;
}

/**
 * Card charges that need a receipt by policy but are OLDER than the chase window, so the
 * chase never opened a request for them. The board's empty state counts these so it never
 * claims "every card charge has its receipt" while the card feed shows "No receipt".
 */
export function olderUnreceiptedCharges(i: OlderChargeInput): ChargeTxn[] {
  return i.txns.filter((t) => {
    if (i.tracked.has(t.id) || i.withReceipt.has(t.id) || t.matched_receipt_id) return false;
    if (!isCardCharge(t, i.accounts.get(t.bank_account_id), i.assignments)) return false;
    const p = i.policyFor(t.location_id);
    if (!receiptRequired(p, Number(t.amount_cents))) return false;
    return !insideWindow(t.transaction_date, p.chaseWindowDays, i.now);
  });
}
