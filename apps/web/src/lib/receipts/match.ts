/**
 * Receipt ↔ card-charge matching (FPB-workforce-app §15.2).
 *
 * SCORE = vendor 40 % + amount 40 % + date 20 % (the bank-feed composite rule, CLAUDE.md
 * "Bank Feed Matching"). Gates: the amount and the date must each score > 0, else the
 * pair is not a candidate at all.
 *   amount  |charge − receipt| ≤ tolerance → 1.0 (linear to 0.9 at the edge);
 *           receipt LOWER than the charge by ≤ tip share of the receipt → 0.75 (a tip
 *           added after the receipt printed); anything else → 0 (no match).
 *   date    0 days → 1.0, −0.1 per day inside the window; outside → 0; unknown → 0.5.
 *   vendor  bigram (Dice) similarity of the cleaned merchant names; unknown → 0.5.
 * BANDS: ≥ auto (0.90) with a clear winner (runner-up ≥ 0.10 behind) and an amount that fits
 *        within tolerance (not only via the tip allowance) → matched;
 *        ≥ suggest (0.70) → suggested (one click confirms); else unmatched.
 *
 * The pure part (scoreMatch / rankCandidates / decideMatch) has no I/O; linkReceipt and
 * autoMatchReceipt do the writes (service role, org pinned) and close the chase.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { serviceWriter } from '@/lib/db/scoped-writer';
import { cleanMerchant } from './charges';
import { closeChaseForCharge } from './chase';
import type { ReceiptPolicy } from './policy';
import type { MatchMethod, ReceiptRow } from './types';

export interface MatchReceipt {
  vendorName: string | null;
  amountCents: number | null;
  receiptDate: string | null;
}

export interface MatchCharge {
  id: string;
  description: string;
  /** Charge size as a POSITIVE number of cents. */
  amountCents: number;
  chargeDate: string;
  cardAssignmentId: string | null;
}

export interface MatchScore {
  total: number;
  vendor: number;
  amount: number;
  date: number;
  /** "tip" when the amount matched only through the tip allowance. */
  amountBasis: 'exact' | 'tolerance' | 'tip' | 'unknown' | 'none';
}

export type MatchTolerances = Pick<ReceiptPolicy, 'amountToleranceCents' | 'tipToleranceBp' | 'dateWindowDays'>;

function bigrams(s: string): string[] {
  const t = s.replace(/\s+/g, ' ').trim();
  const out: string[] = [];
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
  return out;
}

/** Dice coefficient over character bigrams of the cleaned names, 0..1. */
export function merchantSimilarity(a: string, b: string): number {
  const x = cleanMerchant(a);
  const y = cleanMerchant(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.9;
  const ax = bigrams(x);
  const by = bigrams(y);
  if (ax.length === 0 || by.length === 0) return 0;
  const pool = new Map<string, number>();
  for (const g of by) pool.set(g, (pool.get(g) ?? 0) + 1);
  let hit = 0;
  for (const g of ax) {
    const n = pool.get(g) ?? 0;
    if (n > 0) {
      hit++;
      pool.set(g, n - 1);
    }
  }
  return (2 * hit) / (ax.length + by.length);
}

function daysBetween(a: string, b: string): number {
  return Math.round(Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

export function amountScore(receiptCents: number | null, chargeCents: number, tol: MatchTolerances): { score: number; basis: MatchScore['amountBasis'] } {
  if (receiptCents == null || receiptCents <= 0) return { score: 0.5, basis: 'unknown' };
  const diff = chargeCents - receiptCents;
  const abs = Math.abs(diff);
  if (abs === 0) return { score: 1, basis: 'exact' };
  if (abs <= tol.amountToleranceCents) {
    const edge = tol.amountToleranceCents > 0 ? abs / tol.amountToleranceCents : 1;
    return { score: 1 - 0.1 * edge, basis: 'tolerance' };
  }
  // Tip added at the table: the card charge is HIGHER than the printed receipt.
  if (diff > 0 && diff * 10_000 <= receiptCents * tol.tipToleranceBp) return { score: 0.75, basis: 'tip' };
  return { score: 0, basis: 'none' };
}

export function dateScore(receiptDate: string | null, chargeDate: string, windowDays: number): number {
  if (!receiptDate) return 0.5;
  const d = daysBetween(receiptDate, chargeDate);
  if (d > windowDays) return 0;
  return Math.max(0.1, 1 - 0.1 * d);
}

/** Score one receipt against one charge. total = 0 means "not a candidate". */
export function scoreMatch(r: MatchReceipt, c: MatchCharge, tol: MatchTolerances): MatchScore {
  const amt = amountScore(r.amountCents, c.amountCents, tol);
  const date = dateScore(r.receiptDate, c.chargeDate, tol.dateWindowDays);
  const vendor = r.vendorName ? merchantSimilarity(r.vendorName, c.description) : 0.5;
  if (amt.score === 0 || date === 0) return { total: 0, vendor, amount: amt.score, date, amountBasis: amt.basis };
  // With neither an amount nor a date we know nothing useful: never more than a weak hint.
  if (amt.basis === 'unknown' && !r.receiptDate) return { total: Math.min(0.4, 0.4 * vendor), vendor, amount: amt.score, date, amountBasis: amt.basis };
  const total = Math.round((0.4 * vendor + 0.4 * amt.score + 0.2 * date) * 10_000) / 10_000;
  return { total, vendor, amount: amt.score, date, amountBasis: amt.basis };
}

export interface RankedCandidate {
  charge: MatchCharge;
  score: MatchScore;
}

/** Candidates best first; the cardholder's own charges win ties (+0.02, capped at 1). */
export function rankCandidates(r: MatchReceipt, charges: ReadonlyArray<MatchCharge>, tol: MatchTolerances, holderId: string | null): RankedCandidate[] {
  return charges
    .map((charge) => {
      const s = scoreMatch(r, charge, tol);
      const bonus = holderId && charge.cardAssignmentId === holderId && s.total > 0 ? 0.02 : 0;
      return { charge, score: { ...s, total: Math.min(1, Math.round((s.total + bonus) * 10_000) / 10_000) } };
    })
    .filter((c) => c.score.total > 0)
    .sort((a, b) => {
      const own = (x: RankedCandidate) => (holderId && x.charge.cardAssignmentId === holderId ? 1 : 0);
      return b.score.total - a.score.total || own(b) - own(a) || a.charge.chargeDate.localeCompare(b.charge.chargeDate);
    });
}

export type MatchDecision =
  | { kind: 'matched'; candidate: RankedCandidate }
  | { kind: 'suggested'; candidate: RankedCandidate }
  | { kind: 'unmatched'; best: RankedCandidate | null };

export const CLEAR_WINNER_GAP = 0.1;

export function decideMatch(ranked: ReadonlyArray<RankedCandidate>, bands: Pick<ReceiptPolicy, 'autoMatchMinScore' | 'suggestMinScore'>): MatchDecision {
  const best = ranked[0] ?? null;
  if (!best) return { kind: 'unmatched', best: null };
  const runnerUp = ranked[1]?.score.total ?? 0;
  const clear = best.score.total - runnerUp >= CLEAR_WINNER_GAP;
  // A tip-only amount fit or an unread amount never auto-matches: a person confirms it.
  const amountSure = best.score.amountBasis === 'exact' || best.score.amountBasis === 'tolerance';
  if (best.score.total >= bands.autoMatchMinScore && clear && amountSure) return { kind: 'matched', candidate: best };
  if (best.score.total >= bands.suggestMinScore) return { kind: 'suggested', candidate: best };
  return { kind: 'unmatched', best };
}

/**
 * A HOLDER's submission (Merit Workforce, magic link, forwarded email) may only AUTO-match
 * that holder's own charge. A better-scoring charge on someone else's card is at most
 * "suggested" — a bookkeeper confirms it; the holder never attaches evidence to (or learns
 * about) another person's charge. Pure.
 */
export function decideHolderMatch(
  ranked: ReadonlyArray<RankedCandidate>,
  bands: Pick<ReceiptPolicy, 'autoMatchMinScore' | 'suggestMinScore'>,
  holderId: string | null,
): MatchDecision {
  const d = decideMatch(ranked, bands);
  if (d.kind !== 'matched') return d;
  if (holderId && d.candidate.charge.cardAssignmentId === holderId) return d;
  return { kind: 'suggested', candidate: d.candidate };
}

/** Flags for a receipt the person attached to a charge they chose (no score gate). */
export function attachFlags(r: MatchReceipt, c: MatchCharge, tol: MatchTolerances): string[] {
  const flags: string[] = [];
  const amt = amountScore(r.amountCents, c.amountCents, tol);
  if (amt.basis === 'none') flags.push('amount_differs');
  if (r.receiptDate && daysBetween(r.receiptDate, c.chargeDate) > Math.max(tol.dateWindowDays, 7)) flags.push('date_differs');
  return flags;
}

// ── writes ────────────────────────────────────────────────────────────────────

export class MatchError extends Error {
  constructor(message: string, readonly status: number = 400) {
    super(message);
    this.name = 'MatchError';
  }
}

export interface LinkOptions {
  method: MatchMethod;
  score: number | null;
  actor: string;
  flags?: string[];
  now: Date;
}

/**
 * Link a receipt to a charge (service role; caller has authorized and proven both rows
 * are in `orgId` and visible to the caller). One receipt per charge: refuses a charge
 * that already has another receipt. Writes receipts + bank_transactions.matched_receipt_id,
 * then closes the chase for the charge (chase.ts closeChaseForCharge).
 */
export async function linkReceiptToCharge(
  db: SupabaseClient,
  orgId: string,
  receiptId: string,
  txnId: string,
  opts: LinkOptions,
): Promise<{ chaseCount: number }> {
  const { data: txn, error: tErr } = await serviceWriter(db)
    .from('bank_transactions')
    .select('id, org_id, location_id, matched_receipt_id, amount_cents')
    .eq('org_id', orgId)
    .eq('id', txnId)
    .maybeSingle();
  if (tErr) throw new MatchError(`Could not read the charge: ${tErr.message}`, 500);
  const t = txn as { id: string; location_id: string; matched_receipt_id: string | null } | null;
  if (!t) throw new MatchError('That charge was not found.', 404);
  if (t.matched_receipt_id && t.matched_receipt_id !== receiptId) throw new MatchError('That charge already has a receipt. Unmatch it first.', 409);

  const { data: rec, error: rErr } = await serviceWriter(db).from('receipts').select('id, location_id, bank_transaction_id, flags').eq('org_id', orgId).eq('id', receiptId).maybeSingle();
  if (rErr) throw new MatchError(`Could not read the receipt: ${rErr.message}`, 500);
  const r = rec as { id: string; location_id: string; bank_transaction_id: string | null; flags: string[] | null } | null;
  if (!r) throw new MatchError('That receipt was not found.', 404);
  if (r.location_id !== t.location_id) throw new MatchError('The receipt and the charge belong to different companies.', 409);
  if (r.bank_transaction_id && r.bank_transaction_id !== txnId) throw new MatchError('That receipt is already matched to another charge. Unmatch it first.', 409);

  const iso = opts.now.toISOString();
  const flags = Array.from(new Set([...(r.flags ?? []).filter((f) => f !== 'amount_differs' && f !== 'date_differs'), ...(opts.flags ?? [])]));
  const { error: upErr } = await serviceWriter(db)
    .from('receipts')
    .update({
      bank_transaction_id: txnId,
      match_status: 'matched',
      match_method: opts.method,
      match_score: opts.score,
      match_candidate_txn_id: null,
      matched_at: iso,
      matched_by: opts.actor,
      flags,
      updated_at: iso,
    })
    .eq('org_id', orgId)
    .eq('id', receiptId);
  if (upErr) {
    if (/duplicate|unique/i.test(upErr.message)) throw new MatchError('That charge already has a receipt.', 409);
    throw new MatchError(`Could not match the receipt: ${upErr.message}`, 500);
  }
  const { error: bErr } = await serviceWriter(db).from('bank_transactions').update({ matched_receipt_id: receiptId, updated_at: iso }).eq('org_id', orgId).eq('id', txnId);
  if (bErr) throw new MatchError(`Could not mark the charge: ${bErr.message}`, 500);

  return closeChaseForCharge(db, orgId, txnId, { receiptId, actor: opts.actor, now: opts.now });
}

/** Undo a match (the charge goes back to needing a receipt; the chase resumes on the next sync). */
export async function unlinkReceipt(db: SupabaseClient, orgId: string, receiptId: string, actor: string, now: Date): Promise<void> {
  const { data: rec } = await serviceWriter(db).from('receipts').select('id, bank_transaction_id').eq('org_id', orgId).eq('id', receiptId).maybeSingle();
  const r = rec as { id: string; bank_transaction_id: string | null } | null;
  if (!r) throw new MatchError('That receipt was not found.', 404);
  if (!r.bank_transaction_id) return;
  const iso = now.toISOString();
  const { error } = await serviceWriter(db)
    .from('receipts')
    .update({ bank_transaction_id: null, match_status: 'unmatched', match_method: null, match_score: null, matched_at: null, matched_by: null, updated_at: iso })
    .eq('org_id', orgId)
    .eq('id', receiptId);
  if (error) throw new MatchError(`Could not unmatch: ${error.message}`, 500);
  await serviceWriter(db).from('bank_transactions').update({ matched_receipt_id: null, updated_at: iso }).eq('org_id', orgId).eq('id', r.bank_transaction_id).eq('matched_receipt_id', receiptId);
  await db
    .from('receipt_charge_states')
    .update({ status: 'needed', receipt_id: null, decided_by: actor, decided_at: iso, reason: null, updated_at: iso })
    .eq('org_id', orgId)
    .eq('bank_transaction_id', r.bank_transaction_id)
    .eq('status', 'matched');
}

interface OpenChargeRow {
  id: string;
  description: string;
  amount_cents: number;
  transaction_date: string;
  bank_account_id: string;
}

/** Open charges (no receipt yet) for a company within ±window+7 days of a date, plus their holders. */
export async function loadOpenCharges(
  db: SupabaseClient,
  orgId: string,
  locationId: string,
  around: string | null,
  windowDays: number,
  now: Date,
): Promise<MatchCharge[]> {
  const span = Math.max(windowDays, 3) + 7;
  const center = around ? Date.parse(`${around}T00:00:00Z`) : now.getTime();
  const from = new Date(center - span * 86_400_000).toISOString().slice(0, 10);
  const to = new Date(center + span * 86_400_000).toISOString().slice(0, 10);
  const { data, error } = await serviceWriter(db)
    .from('bank_transactions')
    .select('id, description, amount_cents, transaction_date, bank_account_id')
    .eq('org_id', orgId)
    .eq('location_id', locationId)
    .is('matched_receipt_id', null)
    .lt('amount_cents', 0)
    .gte('transaction_date', from)
    .lte('transaction_date', to)
    .limit(500);
  if (error) throw new MatchError(`Could not read charges: ${error.message}`, 500);
  const rows = (data ?? []) as OpenChargeRow[];
  if (rows.length === 0) return [];
  const { data: states } = await db
    .from('receipt_charge_states')
    .select('bank_transaction_id, card_assignment_id, status')
    .eq('org_id', orgId)
    .in('bank_transaction_id', rows.map((r) => r.id));
  const holder = new Map<string, { a: string | null; s: string }>();
  for (const s of (states ?? []) as Array<{ bank_transaction_id: string; card_assignment_id: string | null; status: string }>) {
    holder.set(s.bank_transaction_id, { a: s.card_assignment_id, s: s.status });
  }
  return rows
    .filter((r) => {
      const st = holder.get(r.id)?.s;
      return st !== 'matched' && st !== 'not_required';
    })
    .map((r) => ({
      id: r.id,
      description: r.description,
      amountCents: Math.abs(Number(r.amount_cents)),
      chargeDate: r.transaction_date,
      cardAssignmentId: holder.get(r.id)?.a ?? null,
    }));
}

export type AutoMatchOutcome =
  | { kind: 'matched'; transactionId: string; score: number }
  | { kind: 'suggested'; transactionId: string; score: number }
  | { kind: 'unmatched' };

/** Score a receipt against its company's open charges and act on the band. */
export async function autoMatchReceipt(
  db: SupabaseClient,
  orgId: string,
  receipt: Pick<ReceiptRow, 'id' | 'location_id' | 'vendor_name' | 'amount_cents' | 'receipt_date' | 'card_assignment_id' | 'bank_transaction_id'>,
  policy: ReceiptPolicy,
  now: Date,
  actor: string,
  opts: { holderOnly?: boolean } = {},
): Promise<AutoMatchOutcome> {
  if (receipt.bank_transaction_id) return { kind: 'matched', transactionId: receipt.bank_transaction_id, score: 1 };
  const charges = await loadOpenCharges(db, orgId, receipt.location_id, receipt.receipt_date, policy.dateWindowDays, now);
  const ranked = rankCandidates(
    { vendorName: receipt.vendor_name, amountCents: receipt.amount_cents != null ? Math.abs(Number(receipt.amount_cents)) : null, receiptDate: receipt.receipt_date },
    charges,
    policy,
    receipt.card_assignment_id,
  );
  const d = opts.holderOnly ? decideHolderMatch(ranked, policy, receipt.card_assignment_id) : decideMatch(ranked, policy);
  const iso = now.toISOString();
  if (d.kind === 'matched') {
    await linkReceiptToCharge(db, orgId, receipt.id, d.candidate.charge.id, { method: 'auto', score: d.candidate.score.total, actor, now });
    return { kind: 'matched', transactionId: d.candidate.charge.id, score: d.candidate.score.total };
  }
  if (d.kind === 'suggested') {
    await serviceWriter(db)
      .from('receipts')
      .update({ match_status: 'suggested', match_candidate_txn_id: d.candidate.charge.id, match_score: d.candidate.score.total, updated_at: iso })
      .eq('org_id', orgId)
      .eq('id', receipt.id);
    return { kind: 'suggested', transactionId: d.candidate.charge.id, score: d.candidate.score.total };
  }
  await serviceWriter(db)
    .from('receipts')
    .update({ match_status: 'unmatched', match_candidate_txn_id: null, match_score: d.best?.score.total ?? null, updated_at: iso })
    .eq('org_id', orgId)
    .eq('id', receipt.id);
  return { kind: 'unmatched' };
}
