/**
 * GATE 12 — AR collection (money-in) GL posting.
 *
 * Flow and the entries each step posts (all balanced; see §3.4 of the spec):
 *   1. Collection confirmed — customer pays gross G, processor fee F:
 *        DR Settlement Clearing (G - F)
 *        DR Merchant Fee Expense (F)
 *        CR A/R Control          (G)
 *      Relieves the receivable for the gross, books the fee, nets cash into the
 *      processor clearing account.
 *   2. Payout to bank — processor deposits the netted batch P:
 *        DR Operating Bank        (P)
 *        CR Settlement Clearing   (P)
 *      The deposit auto-matches the bank feed.
 *   3. Refund of R:
 *        DR A/R Control           (R)
 *        CR Settlement Clearing   (R)
 *
 * The pure build* functions are DB-free (verifiable for balance). The post*
 * wrappers resolve roles and post through the engine.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { postJournalEntry, type PostResult } from '@/lib/services/gl-posting';
import { resolveRole } from '@/lib/posting/account-roles';
import { type MoneyMovementEntry, line, assertBalanced } from './types';

export interface ArCollectionAccounts {
  settlementClearingId: string;
  merchantFeeExpenseId: string;
  arControlId: string;
}

/** Step 1 — collection confirmed (gross relieved from AR, fee booked, net to clearing). */
export function buildArCollectionEntry(
  acc: ArCollectionAccounts,
  grossCents: number,
  feeCents: number,
  locationId: string,
  memo = 'AR collection (processor)',
): MoneyMovementEntry {
  if (grossCents <= 0) throw new Error('grossCents must be > 0');
  if (feeCents < 0 || feeCents > grossCents) throw new Error('feeCents out of range');
  const netCents = grossCents - feeCents;
  const lines = [
    line(acc.settlementClearingId, 'debit', netCents, locationId, { memo: 'Net to processor clearing' }),
    ...(feeCents > 0 ? [line(acc.merchantFeeExpenseId, 'debit', feeCents, locationId, { memo: 'Processor fee' })] : []),
    line(acc.arControlId, 'credit', grossCents, locationId, { memo: 'Relieve A/R' }),
  ];
  return assertBalanced({ entryType: 'AR_COLLECTION', memo, lines });
}

/** Step 2 — payout deposited from clearing to the operating bank. */
export function buildArPayoutEntry(
  operatingBankId: string,
  settlementClearingId: string,
  payoutCents: number,
  locationId: string,
  memo = 'AR processor payout',
): MoneyMovementEntry {
  if (payoutCents <= 0) throw new Error('payoutCents must be > 0');
  const lines = [
    line(operatingBankId, 'debit', payoutCents, locationId, { memo: 'Payout to bank' }),
    line(settlementClearingId, 'credit', payoutCents, locationId, { memo: 'Clear processor clearing' }),
  ];
  return assertBalanced({ entryType: 'AR_PAYOUT', memo, lines });
}

/** Step 3 — refund (reverses the collection's A/R relief through clearing). */
export function buildArRefundEntry(
  arControlId: string,
  settlementClearingId: string,
  refundCents: number,
  locationId: string,
  memo = 'AR refund',
): MoneyMovementEntry {
  if (refundCents <= 0) throw new Error('refundCents must be > 0');
  const lines = [
    line(arControlId, 'debit', refundCents, locationId, { memo: 'Reinstate A/R (refund)' }),
    line(settlementClearingId, 'credit', refundCents, locationId, { memo: 'Refund via processor' }),
  ];
  return assertBalanced({ entryType: 'AR_REFUND', memo, lines });
}

// --------------------------------------------------------------------------
// Post wrappers (resolve roles, then post through the engine)
// --------------------------------------------------------------------------

async function postEntry(
  supabase: SupabaseClient,
  orgId: string,
  locationId: string,
  entryDate: string,
  createdBy: string | null,
  entry: MoneyMovementEntry,
  sourceId?: string,
): Promise<PostResult> {
  return postJournalEntry(supabase, {
    org_id: orgId,
    location_id: locationId,
    entry_date: entryDate,
    entry_type: entry.entryType,
    memo: entry.memo,
    source_module: 'MONEY_MOVEMENT',
    source_ref: sourceId, // Stripe pi_/po_ id — external string, not a uuid
    created_by: createdBy,
    lines: entry.lines,
  });
}

export async function postArCollection(
  supabase: SupabaseClient,
  args: { orgId: string; locationId: string; entryDate: string; grossCents: number; feeCents: number; createdBy: string | null; sourceId?: string },
): Promise<PostResult> {
  const [clearing, fee, ar] = await Promise.all([
    resolveRole(supabase, args.orgId, 'SETTLEMENT_CLEARING', args.locationId),
    resolveRole(supabase, args.orgId, 'MERCHANT_FEE_EXPENSE'),
    resolveRole(supabase, args.orgId, 'AR_CONTROL'),
  ]);
  const entry = buildArCollectionEntry(
    { settlementClearingId: clearing.id, merchantFeeExpenseId: fee.id, arControlId: ar.id },
    args.grossCents,
    args.feeCents,
    args.locationId,
  );
  return postEntry(supabase, args.orgId, args.locationId, args.entryDate, args.createdBy, entry, args.sourceId);
}

export async function postArPayout(
  supabase: SupabaseClient,
  args: { orgId: string; locationId: string; entryDate: string; payoutCents: number; createdBy: string | null; sourceId?: string },
): Promise<PostResult> {
  const [bank, clearing] = await Promise.all([
    resolveRole(supabase, args.orgId, 'OPERATING_BANK', args.locationId),
    resolveRole(supabase, args.orgId, 'SETTLEMENT_CLEARING', args.locationId),
  ]);
  const entry = buildArPayoutEntry(bank.id, clearing.id, args.payoutCents, args.locationId);
  return postEntry(supabase, args.orgId, args.locationId, args.entryDate, args.createdBy, entry, args.sourceId);
}

export async function postArRefund(
  supabase: SupabaseClient,
  args: { orgId: string; locationId: string; entryDate: string; refundCents: number; createdBy: string | null; sourceId?: string },
): Promise<PostResult> {
  const [ar, clearing] = await Promise.all([
    resolveRole(supabase, args.orgId, 'AR_CONTROL'),
    resolveRole(supabase, args.orgId, 'SETTLEMENT_CLEARING', args.locationId),
  ]);
  const entry = buildArRefundEntry(ar.id, clearing.id, args.refundCents, args.locationId);
  return postEntry(supabase, args.orgId, args.locationId, args.entryDate, args.createdBy, entry, args.sourceId);
}
