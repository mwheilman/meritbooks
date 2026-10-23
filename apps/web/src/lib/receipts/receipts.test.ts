/**
 * Pure parts of receipt capture & chase (FPB-workforce-app §15.3): policy thresholds and
 * merge, the chase switch, card-charge detection and cardholder resolution, grace / window,
 * request shaping (cadence, channels, escalation), matching tolerance + bands, the
 * deterministic receipt reader, the file guard, inbound attachment filtering, the
 * resolver decision, the digest.
 */
import { describe, expect, it } from 'vitest';
import { decideChargeState, graceElapsed, insideWindow, isCardCharge, isCardPaymentLine, merchantLabel, resolveCardholder, shouldOpenRequest } from './charges';
import { escalationTarget, mayOpenRequest, PAUSE_PREFIX, receiptOffsets, receiptRequestChannels, recipientFor, requestTitle } from './chase';
import { checkReceiptBytes, checkReceiptFile, mergeFacts, neutralizeHtml } from './capture';
import { normalizeCardholder, CardholderError } from './cardholders';
import { buildDigest, isoWeekKey } from './digest';
import { findDate, findLast4, findTotal, htmlToText, normalizeReceiptExtraction, parseReceiptText, EMPTY_FACTS } from './extract';
import { bodyLooksLikeReceipt, merchantFromSubject, receiptAttachments } from './inbound';
import { derivedWorkforceToken, hashWorkforceToken, looksLikeWorkforceToken } from './links';
import { amountScore, attachFlags, dateScore, decideHolderMatch, decideMatch, merchantSimilarity, rankCandidates, scoreMatch, type MatchCharge } from './match';
import { RECEIPT_POLICY_DEFAULTS, chaseEnabledFor, chaseResumedAt, memoRequired, mergeReceiptPolicy, policyPatchToRow, receiptRequired, validatePolicyPatch, type ChaseSwitches, type ReceiptPolicyRow } from './policy';
import { decideReceiptRequest } from './resolver';
import type { CardAccount, CardAssignmentRow, ChargeTxn } from './types';

const ORG = 'o1';
const LOC = 'l1';
const LOC2 = 'l2';
const CARD_ACCT = 'acct-card';
const CHK_ACCT = 'acct-chk';

function assignment(p: Partial<CardAssignmentRow> = {}): CardAssignmentRow {
  return {
    id: 'a1',
    org_id: ORG,
    location_id: LOC,
    bank_account_id: CARD_ACCT,
    card_last4: null,
    card_label: null,
    holder_type: 'employee',
    membership_id: null,
    employee_id: 'e1',
    holder_name: 'Andre Willis',
    holder_email: 'andre@example.com',
    holder_phone: null,
    holder_timezone: 'America/Chicago',
    manager_membership_id: 'm-mgr',
    active: true,
    starts_on: null,
    ends_on: null,
    chase_opt_out: false,
    opt_out_status: 'none',
    opt_out_reason: null,
    opt_out_requested_by: null,
    opt_out_requested_at: null,
    opt_out_decided_by: null,
    opt_out_decided_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...p,
  };
}

function txn(p: Partial<ChargeTxn> = {}): ChargeTxn {
  return {
    id: 't1',
    org_id: ORG,
    location_id: LOC,
    bank_account_id: CARD_ACCT,
    transaction_date: '2026-10-20',
    description: 'SHELL OIL 57442 DES MOINES IA',
    amount_cents: -6842,
    matched_receipt_id: null,
    matched_bill_id: null,
    ...p,
  };
}

const cardAcct: CardAccount = { id: CARD_ACCT, location_id: LOC, account_type: 'CREDIT_CARD', account_mask: '5512', account_name: 'Ramp', is_active: true };
const chkAcct: CardAccount = { id: CHK_ACCT, location_id: LOC, account_type: 'CHECKING', account_mask: '0001', account_name: 'Operating', is_active: true };

describe('receipt policy', () => {
  it('defaults: receipt over 75.00, reminders day 0/2/5/10, escalate to the manager', () => {
    const p = mergeReceiptPolicy([], LOC);
    expect(p.receiptRequiredOverCents).toBe(7500);
    expect(p.reminderDays).toEqual([0, 2, 5, 10]);
    expect(p.escalateTo).toBe('manager');
    expect(receiptRequired(p, -7500)).toBe(false);
    expect(receiptRequired(p, -7501)).toBe(true);
  });

  it('client row overrides the tenant row; null columns inherit', () => {
    const base: Omit<ReceiptPolicyRow, 'location_id'> = {
      receipt_required_over_cents: null,
      memo_required: null,
      memo_required_over_cents: null,
      grace_days: null,
      chase_window_days: null,
      reminder_days: null,
      escalate_to: null,
      bookkeeper_membership_id: null,
      amount_tolerance_cents: null,
      tip_tolerance_bp: null,
      date_window_days: null,
      auto_match_min_score: null,
      suggest_min_score: null,
      digest_enabled: null,
    };
    const rows: ReceiptPolicyRow[] = [
      { ...base, location_id: null, receipt_required_over_cents: 2500, grace_days: 2, bookkeeper_membership_id: 'bk' },
      { ...base, location_id: LOC, receipt_required_over_cents: 10000, memo_required: true, auto_match_min_score: '0.95' },
    ];
    const client = mergeReceiptPolicy(rows, LOC);
    expect(client.receiptRequiredOverCents).toBe(10000);
    expect(client.graceDays).toBe(2);
    expect(client.bookkeeperMembershipId).toBe('bk');
    expect(client.autoMatchMinScore).toBe(0.95);
    expect(memoRequired(client, -1)).toBe(true);
    expect(mergeReceiptPolicy(rows, LOC2).receiptRequiredOverCents).toBe(2500);
  });

  it('validates a patch and maps it to columns', () => {
    expect(validatePolicyPatch({ graceDays: 31 })).toMatch(/Grace/);
    expect(validatePolicyPatch({ reminderDays: [] })).toMatch(/reminder/);
    expect(validatePolicyPatch({ autoMatchMinScore: 0.8, suggestMinScore: 0.85 })).toMatch(/suggest/);
    expect(validatePolicyPatch({ ...RECEIPT_POLICY_DEFAULTS })).toBeNull();
    expect(policyPatchToRow({ graceDays: 3, reminderDays: [0, 3] })).toEqual({ grace_days: 3, reminder_days: [0, 3] });
  });
});

describe('the chase switch (tenant and client)', () => {
  const sw = (tenant: boolean, client?: boolean | null, changedAt: string | null = null): ChaseSwitches => ({
    tenantEnabled: tenant,
    tenantChangedAt: '2026-10-01T00:00:00Z',
    clients: new Map(client === undefined ? [] : [[LOC, { enabled: client, changedAt }]]),
  });
  it('effective = tenant on AND (client null or on)', () => {
    expect(chaseEnabledFor(sw(true), LOC)).toBe(true);
    expect(chaseEnabledFor(sw(true, null), LOC)).toBe(true);
    expect(chaseEnabledFor(sw(true, false), LOC)).toBe(false);
    expect(chaseEnabledFor(sw(false, true), LOC)).toBe(false);
    expect(chaseEnabledFor(sw(true, false), LOC2)).toBe(true);
  });
  it('resumed-at is the later of the tenant and client switch-on', () => {
    expect(chaseResumedAt(sw(true, true, '2026-10-15T00:00:00Z'), LOC)).toBe('2026-10-15T00:00:00Z');
    expect(chaseResumedAt(sw(true), LOC)).toBe('2026-10-01T00:00:00Z');
  });
});

describe('card charges and cardholders', () => {
  it('payments, refunds and bill-settled lines are not charges', () => {
    expect(isCardPaymentLine('AUTOMATIC PAYMENT - THANK')).toBe(true);
    expect(isCardPaymentLine('ONLINE PAYMENT RECEIVED')).toBe(true);
    expect(isCardCharge(txn({ description: 'AUTOMATIC PAYMENT - THANK' }), cardAcct, [])).toBe(false);
    expect(isCardCharge(txn({ amount_cents: 6842 }), cardAcct, [])).toBe(false);
    expect(isCardCharge(txn({ matched_bill_id: 'b1' }), cardAcct, [])).toBe(false);
    expect(isCardCharge(txn(), cardAcct, [])).toBe(true);
  });

  it('a debit-card line on checking counts only when an assigned last 4 appears', () => {
    const t = txn({ bank_account_id: CHK_ACCT, description: 'DEBIT CARD PURCHASE 5512 HOME DEPOT' });
    expect(isCardCharge(t, chkAcct, [])).toBe(false);
    expect(isCardCharge(t, chkAcct, [assignment({ bank_account_id: null, card_last4: '5512' })])).toBe(true);
    expect(isCardCharge(txn({ bank_account_id: CHK_ACCT, description: 'ACH 155120 RENT' }), chkAcct, [assignment({ bank_account_id: null, card_last4: '5512' })])).toBe(false);
  });

  it('resolves the cardholder: last 4 on the account → whole account → loose last 4; date + company bound', () => {
    const whole = assignment({ id: 'whole' });
    const byCard = assignment({ id: 'card', card_last4: '7788' });
    expect(resolveCardholder(txn({ description: 'UBER *TRIP x7788' }), cardAcct, [whole, byCard])?.id).toBe('card');
    expect(resolveCardholder(txn(), cardAcct, [whole, byCard])?.id).toBe('whole');
    const loose = assignment({ id: 'loose', bank_account_id: null, card_last4: '5512' });
    expect(resolveCardholder(txn(), cardAcct, [loose])?.id).toBe('loose'); // account mask = 5512
    expect(resolveCardholder(txn(), cardAcct, [assignment({ ends_on: '2026-10-01' })])).toBeNull();
    expect(resolveCardholder(txn(), cardAcct, [assignment({ location_id: LOC2 })])).toBeNull();
    expect(resolveCardholder(txn(), cardAcct, [assignment({ active: false })])).toBeNull();
  });

  it('decides the state: matched > not required > under the limit > no cardholder > chase off > opted out > needed', () => {
    const policy = mergeReceiptPolicy([], LOC);
    const base = { txn: txn({ amount_cents: -12000 }), holder: assignment(), policy, chaseOn: true, hasReceipt: false, waived: false };
    expect(decideChargeState(base)).toBe('needed');
    expect(decideChargeState({ ...base, hasReceipt: true })).toBe('matched');
    expect(decideChargeState({ ...base, waived: true })).toBe('not_required');
    expect(decideChargeState({ ...base, txn: txn({ amount_cents: -7500 }) })).toBe('below_threshold');
    expect(decideChargeState({ ...base, holder: null })).toBe('no_cardholder');
    expect(decideChargeState({ ...base, chaseOn: false })).toBe('chase_off');
    expect(decideChargeState({ ...base, holder: assignment({ chase_opt_out: true, opt_out_status: 'approved' }) })).toBe('opted_out');
  });

  it('grace days and the chase window', () => {
    const now = new Date('2026-10-22T12:00:00Z');
    expect(graceElapsed('2026-10-20', 2, now)).toBe(true);
    expect(graceElapsed('2026-10-21', 2, now)).toBe(false);
    expect(insideWindow('2026-08-24', 60, now)).toBe(true);
    expect(insideWindow('2026-08-22', 60, now)).toBe(false);
    expect(shouldOpenRequest('2026-10-22', { graceDays: 0, chaseWindowDays: 60 }, now)).toBe(true);
    expect(shouldOpenRequest('2026-07-01', { graceDays: 0, chaseWindowDays: 60 }, now)).toBe(false);
  });

  it('cleans card-network noise from merchant names', () => {
    expect(merchantLabel('SQ *BLUE BOTTLE COFFEE #123 OAKLAND CA')).toBe('Blue Bottle Coffee Oakland');
    expect(merchantLabel('TST* LOCAL BISTRO')).toBe('Local Bistro');
  });
});

describe('receipt requests', () => {
  it('first ask = Settings first-reminder minutes, then the policy days', () => {
    expect(receiptOffsets([0, 2, 5, 10], 30)).toEqual([30, 2880, 7200, 14400]);
    expect(receiptOffsets([10, 0, 2, 2], 0)).toEqual([0, 2880, 14400]);
  });

  it('email always, in-app for members, plus the Settings channel', () => {
    expect(receiptRequestChannels({ membership_id: null, holder_email: 'a@b.co' }, 'PUSH_SMS')).toEqual(['email', 'push', 'sms']);
    expect(receiptRequestChannels({ membership_id: 'm', holder_email: 'a@b.co' }, 'PUSH_SMS_EMAIL')).toEqual(['email', 'in_app', 'push', 'sms']);
    expect(receiptRequestChannels({ membership_id: 'm', holder_email: null }, 'PUSH_ONLY')).toEqual(['in_app', 'push']);
  });

  it('escalates to the manager, else the bookkeeper (or as the policy says)', () => {
    expect(escalationTarget({ manager_membership_id: 'mgr' }, { escalateTo: 'manager', bookkeeperMembershipId: 'bk' })).toBe('mgr');
    expect(escalationTarget({ manager_membership_id: null }, { escalateTo: 'manager', bookkeeperMembershipId: 'bk' })).toBe('bk');
    expect(escalationTarget({ manager_membership_id: 'mgr' }, { escalateTo: 'bookkeeper', bookkeeperMembershipId: 'bk' })).toBe('bk');
    expect(escalationTarget({ manager_membership_id: 'mgr' }, { escalateTo: 'none', bookkeeperMembershipId: 'bk' })).toBeNull();
  });

  it('recipient type follows the holder type', () => {
    expect(recipientFor(assignment()).type).toBe('employee');
    expect(recipientFor(assignment({ holder_type: 'member', membership_id: 'm' })).type).toBe('member');
    expect(recipientFor(assignment({ holder_type: 'external', employee_id: null })).type).toBe('email');
    expect(requestTitle('Shell Oil', -6842, '2026-10-20')).toBe('Receipt for Shell Oil · $68.42 on 2026-10-20');
  });

  it('only paused requests re-open (a person’s cancel stays cancelled)', () => {
    expect(mayOpenRequest(undefined)).toBe(true);
    expect(mayOpenRequest({ status: 'sent', cancel_reason: null })).toBe(false);
    expect(mayOpenRequest({ status: 'expired', cancel_reason: null })).toBe(false);
    expect(mayOpenRequest({ status: 'cancelled', cancel_reason: `${PAUSE_PREFIX} receipt chase is turned off` })).toBe(true);
    expect(mayOpenRequest({ status: 'cancelled', cancel_reason: 'Duplicate' })).toBe(false);
  });

  it('the engine resolver closes a request once the charge has a receipt or is waived', () => {
    const ev = { receiptTxnIds: new Set(['t1']), matchedTxnIds: new Set(['t2']), states: new Map([['t3', 'matched'], ['t4', 'not_required'], ['t5', 'requested']]) };
    for (const id of ['t1', 't2', 't3', 't4']) expect(decideReceiptRequest({ subject_type: 'bank_transaction', subject_id: id }, ev).satisfied).toBe(true);
    expect(decideReceiptRequest({ subject_type: 'bank_transaction', subject_id: 't5' }, ev).satisfied).toBe(false);
    expect(decideReceiptRequest({ subject_type: 'none', subject_id: null }, ev).satisfied).toBe(false);
  });
});

describe('matching tolerance', () => {
  const tol = { amountToleranceCents: 500, tipToleranceBp: 2500, dateWindowDays: 3 };
  const charge = (p: Partial<MatchCharge> = {}): MatchCharge => ({ id: 'c1', description: 'SHELL OIL 57442', amountCents: 6842, chargeDate: '2026-10-20', cardAssignmentId: null, ...p });

  it('±5.00 and ±3 days match; outside either is not a candidate', () => {
    expect(amountScore(6842, 6842, tol).basis).toBe('exact');
    expect(amountScore(6400, 6842, tol).basis).toBe('tolerance');
    expect(amountScore(6300, 6842, tol).basis).toBe('tip'); // 5.42 under the charge = tip ≤ 25 %
    expect(amountScore(7400, 6842, tol).basis).toBe('none'); // receipt HIGHER by 5.58
    expect(dateScore('2026-10-17', '2026-10-20', 3)).toBeCloseTo(0.7);
    expect(dateScore('2026-10-16', '2026-10-20', 3)).toBe(0);
    expect(scoreMatch({ vendorName: 'Shell', amountCents: 6842, receiptDate: '2026-10-16' }, charge(), tol).total).toBe(0);
  });

  it('a 20 % tip suggests; 30 % does not match at all', () => {
    const r20 = scoreMatch({ vendorName: 'Local Bistro', amountCents: 5000, receiptDate: '2026-10-20' }, charge({ description: 'TST* LOCAL BISTRO', amountCents: 6000 }), tol);
    expect(r20.amountBasis).toBe('tip');
    expect(r20.total).toBeGreaterThanOrEqual(0.7);
    // a tip-only fit never auto-matches, even with a perfect vendor and date
    expect(decideMatch([{ charge: charge(), score: r20 }], { autoMatchMinScore: 0.9, suggestMinScore: 0.7 }).kind).toBe('suggested');
    const r30 = scoreMatch({ vendorName: 'Local Bistro', amountCents: 5000, receiptDate: '2026-10-20' }, charge({ description: 'TST* LOCAL BISTRO', amountCents: 6500 }), tol);
    expect(r30.total).toBe(0);
  });

  it('a clear winner auto-matches; a tie only suggests', () => {
    const r = { vendorName: 'Shell Oil', amountCents: 6842, receiptDate: '2026-10-20' };
    const bands = { autoMatchMinScore: 0.9, suggestMinScore: 0.7 };
    const one = rankCandidates(r, [charge(), charge({ id: 'c2', description: 'HOME DEPOT', amountCents: 9999 })], tol, null);
    expect(decideMatch(one, bands)).toMatchObject({ kind: 'matched', candidate: { charge: { id: 'c1' } } });
    const tie = rankCandidates(r, [charge(), charge({ id: 'c2' })], tol, null);
    expect(decideMatch(tie, bands).kind).toBe('suggested');
    // the cardholder's own charge breaks a tie
    const own = rankCandidates(r, [charge(), charge({ id: 'c2', cardAssignmentId: 'me' })], tol, 'me');
    expect(own[0].charge.id).toBe('c2');
    expect(decideMatch([], bands).kind).toBe('unmatched');
  });

  it('M5: a holder submission auto-matches only its OWN charge; another person’s is at most suggested', () => {
    const r = { vendorName: 'Shell Oil', amountCents: 6842, receiptDate: '2026-10-20' };
    const bands = { autoMatchMinScore: 0.9, suggestMinScore: 0.7 };
    const others = rankCandidates(r, [charge({ cardAssignmentId: 'someone-else' })], tol, 'me');
    expect(decideMatch(others, bands).kind).toBe('matched'); // the bookkeeper's desk path would match
    expect(decideHolderMatch(others, bands, 'me')).toMatchObject({ kind: 'suggested', candidate: { charge: { id: 'c1' } } });
    expect(decideHolderMatch(rankCandidates(r, [charge({ cardAssignmentId: null })], tol, 'me'), bands, 'me').kind).toBe('suggested'); // unassigned charge
    expect(decideHolderMatch(rankCandidates(r, [charge({ cardAssignmentId: 'me' })], tol, 'me'), bands, 'me').kind).toBe('matched');
    expect(decideHolderMatch(others, bands, null).kind).toBe('suggested'); // no holder at all
  });

  it('merchant similarity ignores card-network noise', () => {
    expect(merchantSimilarity('Blue Bottle Coffee', 'SQ *BLUE BOTTLE COFFEE #12')).toBeGreaterThan(0.85);
    expect(merchantSimilarity('Home Depot', 'SHELL OIL 57442')).toBeLessThan(0.3);
  });

  it('flags an attached receipt whose amount differs from the charge', () => {
    expect(attachFlags({ vendorName: null, amountCents: 1000, receiptDate: null }, charge(), tol)).toEqual(['amount_differs']);
    expect(attachFlags({ vendorName: null, amountCents: 6842, receiptDate: '2026-10-20' }, charge(), tol)).toEqual([]);
  });
});

describe('reading receipts without AI', () => {
  it('finds the total (not the subtotal), the date and the card', () => {
    const text = 'Thanks for riding\nSubtotal $60.00\nTip $8.42\nTotal $68.42\nVisa ending in 5512\nOct 20, 2026';
    expect(findTotal(text)).toBe(6842);
    expect(findDate(text)).toBe('2026-10-20');
    expect(findLast4(text)).toBe('5512');
    expect(findDate('Date: 10/20/26')).toBe('2026-10-20');
    expect(findDate('2026-02-30')).toBeNull();
    expect(findTotal('Amount charged: 1,204.50')).toBe(120450);
    expect(findTotal('nothing here')).toBeNull();
  });

  it('parses an e-receipt body with the sender as merchant', () => {
    const f = parseReceiptText(htmlToText('<p>Your order</p><table><tr><td>Order total</td><td>$42.10</td></tr></table><p>Placed 2026-10-19</p>'), { merchant: 'Amazon' });
    expect(f).toMatchObject({ merchant: 'Amazon', totalCents: 4210, date: '2026-10-19', source: 'rules', confidence: 0.7 });
  });

  it('normalizes the model JSON and blanks what is unreadable', () => {
    const f = normalizeReceiptExtraction({ merchant: ' Shell ', date: '2026-10-20', total: 68.42, subtotal: '60.00', tax: null, tip: 8.42, card_last4: '5512', confidence: 0.92 });
    expect(f).toMatchObject({ merchant: 'Shell', totalCents: 6842, subtotalCents: 6000, tipCents: 842, cardLast4: '5512', confidence: 0.92 });
    expect(normalizeReceiptExtraction({ date: 'yesterday', total: 'lots', card_last4: '55' })).toMatchObject({ date: null, totalCents: null, cardLast4: null });
    // a total that doesn't add up lowers confidence
    expect(normalizeReceiptExtraction({ total: 100, subtotal: 50, confidence: 0.9 }).confidence).toBe(0.6);
  });

  it('typed facts win over the reader', () => {
    expect(mergeFacts({ ...EMPTY_FACTS, merchant: 'X', totalCents: 1 }, { merchant: 'Shell', amountCents: 6842, date: '2026-10-20' })).toMatchObject({ merchant: 'Shell', totalCents: 6842, date: '2026-10-20' });
  });
});

describe('file content (magic bytes) and HTML neutralizing', () => {
  it('accepts real signatures and refuses mismatched bytes', () => {
    expect(checkReceiptBytes('application/pdf', Buffer.from('%PDF-1.7 x'))).toBeNull();
    expect(checkReceiptBytes('image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBeNull();
    expect(checkReceiptBytes('image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBeNull();
    expect(checkReceiptBytes('image/heic', Buffer.from('\0\0\0\x18ftypheic0000', 'latin1'))).toBeNull();
    expect(checkReceiptBytes('image/webp', Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'))).toBeNull();
    expect(checkReceiptBytes('application/pdf', Buffer.from('<html><script>'))).toMatch(/does not match/);
    expect(checkReceiptBytes('image/jpeg', Buffer.from('%PDF-1.4'))).toMatch(/does not match/);
    expect(checkReceiptBytes('text/plain', Buffer.from([0x4d, 0x5a, 0x00, 0x01]))).toMatch(/does not match/);
    expect(checkReceiptBytes('application/x-msdownload', Buffer.from('MZ'))).toMatch(/does not match/);
  });
  it('an HTML receipt is stored as plain text, never as HTML', () => {
    const html = Buffer.from('<p>Total $12.00</p><script>steal()</script>').toString('base64');
    const f = neutralizeHtml({ base64: html, fileName: 'uber.html', mimeType: 'text/html', sizeBytes: 40 });
    expect(f.mimeType).toBe('text/plain');
    expect(f.fileName).toBe('uber.txt');
    expect(Buffer.from(f.base64, 'base64').toString('utf8')).toBe('Total $12.00');
    const pdf = { base64: 'JVBERg==', fileName: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 4 };
    expect(neutralizeHtml(pdf)).toBe(pdf);
  });
  it('a reminder link derives a stable, well-formed Workforce token', () => {
    const t = derivedWorkforceToken('request-token-abc', 'req-1');
    expect(looksLikeWorkforceToken(t)).toBe(true);
    expect(derivedWorkforceToken('request-token-abc', 'req-1')).toBe(t);
    expect(derivedWorkforceToken('request-token-xyz', 'req-1')).not.toBe(t);
  });
});

describe('files, email, links, cardholders, digest', () => {
  it('accepts photos and PDFs, refuses others and mismatched extensions', () => {
    expect(checkReceiptFile({ fileName: 'r.jpg', mimeType: 'image/jpeg', sizeBytes: 1000 })).toBeNull();
    expect(checkReceiptFile({ fileName: 'r.HEIC', mimeType: 'image/heic', sizeBytes: 1000 })).toBeNull();
    expect(checkReceiptFile({ fileName: 'r.pdf', mimeType: 'application/pdf', sizeBytes: 1000 })).toBeNull();
    expect(checkReceiptFile({ fileName: 'r.exe', mimeType: 'application/octet-stream', sizeBytes: 1000 })).toMatch(/photo/);
    expect(checkReceiptFile({ fileName: 'r.pdf', mimeType: 'image/jpeg', sizeBytes: 1000 })).toMatch(/does not match/);
    expect(checkReceiptFile({ fileName: 'r.jpg', mimeType: 'image/jpeg', sizeBytes: 16 * 1024 * 1024 })).toMatch(/large/);
  });

  it('skips inline logos and tiny images in forwarded mail', () => {
    const a = (p: Partial<{ fileName: string; contentType: string; sizeBytes: number; inline: boolean }>) => ({
      fileName: 'r.jpg',
      contentType: 'image/jpeg',
      base64: '',
      sizeBytes: 50_000,
      sha256: '0'.repeat(64),
      contentId: null,
      inline: false,
      ...p,
    });
    const kept = receiptAttachments({ attachments: [a({}), a({ fileName: 'logo.png', contentType: 'image/png', sizeBytes: 3000, inline: true }), a({ fileName: 'x.zip', contentType: 'application/zip' }), a({ fileName: 'r.pdf', contentType: 'application/pdf' })] });
    expect(kept.map((k) => k.fileName)).toEqual(['r.jpg', 'r.pdf']);
    expect(bodyLooksLikeReceipt({ subject: 'Your Uber receipt', textBody: 'Total $23.10', htmlBody: null })).toBe(true);
    expect(bodyLooksLikeReceipt({ subject: 'Lunch?', textBody: 'see you at noon', htmlBody: null })).toBe(false);
    expect(merchantFromSubject('Fwd: Your Home Depot receipt')).toBe('Home Depot');
    expect(merchantFromSubject('FW: Re: Your trip with Uber')).toBe('Uber');
    expect(merchantFromSubject('Fwd: receipt')).toBeNull();
  });

  it('workforce links are hashed; a pasted hash is not a token', () => {
    const tok = 'A'.repeat(43);
    expect(looksLikeWorkforceToken(tok)).toBe(true);
    expect(looksLikeWorkforceToken(hashWorkforceToken(tok))).toBe(false);
    expect(hashWorkforceToken(tok)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('validates a cardholder', () => {
    const ok = normalizeCardholder({ locationId: LOC, bankAccountId: CARD_ACCT, holderType: 'employee', employeeId: 'e1', holderName: 'Andre', holderEmail: 'ANDRE@Example.com', cardLast4: '5512' });
    expect(ok).toMatchObject({ holder_email: 'andre@example.com', card_last4: '5512' });
    expect(() => normalizeCardholder({ locationId: LOC, holderType: 'employee', employeeId: 'e1', holderName: 'A', holderEmail: 'a@b.co' })).toThrow(CardholderError);
    expect(() => normalizeCardholder({ locationId: LOC, cardLast4: '55', holderType: 'external', holderName: 'A', holderEmail: 'a@b.co' })).toThrow(/four digits/);
    expect(() => normalizeCardholder({ locationId: LOC, cardLast4: '5512', holderType: 'external', holderName: 'A' })).toThrow(/email/);
  });

  it('builds the weekly digest', () => {
    expect(isoWeekKey(new Date('2026-10-23T12:00:00Z'))).toBe('2026-W43');
    expect(isoWeekKey(new Date('2027-01-01T12:00:00Z'))).toBe('2026-W53');
    expect(buildDigest([], 'Heartland', 'https://x')).toBeNull();
    const d = buildDigest(
      [{ assignmentId: 'a', holderName: 'Andre <Willis>', holderEmail: null, cardLabel: null, count: 2, totalCents: 15000, oldestDays: 12, charges: [] }],
      'Heartland',
      'https://app.example.com/',
    )!;
    expect(d.title).toBe('2 receipts outstanding · $150.00');
    expect(d.html).toContain('Andre &lt;Willis&gt;');
    expect(d.text).toContain('https://app.example.com/receipts');
  });
});
