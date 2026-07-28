/**
 * GATE 12 — AP disbursement (money-out) GL posting.
 *
 * The bill is already expensed at approval (DR expense / CR A/P). Disbursement
 * only moves the cash side, modeling the 1–3 day float through a clearing
 * account so Cash never moves before settlement confirms (§3.4):
 *
 *   Release (funds committed, leaving A/P, not yet out of bank):
 *        DR A/P Control          (X)
 *        CR Payments in Transit  (X)
 *   Settlement (funds actually leave the bank):
 *        DR Payments in Transit  (X)
 *        CR Operating Bank       (X)
 *   Return / NSF (settlement reversed — money came back to the bank):
 *        DR Operating Bank       (X)
 *        CR Payments in Transit  (X)
 *   Void before settlement (unwind the release — re-establish the payable):
 *        DR Payments in Transit  (X)
 *        CR A/P Control          (X)
 *
 * Pure build* functions are DB-free (balance-verifiable). post* wrappers resolve
 * roles and post through the engine. Money movement is released by an explicit,
 * non-preparer human action upstream (approval engine) — these only post the GL.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { postJournalEntry, type PostResult } from '@/lib/services/gl-posting';
import { resolveRole } from '@/lib/posting/account-roles';
import { type MoneyMovementEntry, line, assertBalanced } from './types';

export function buildApReleaseEntry(
  apControlId: string,
  paymentsInTransitId: string,
  amountCents: number,
  locationId: string,
  memo = 'AP disbursement released',
): MoneyMovementEntry {
  if (amountCents <= 0) throw new Error('amountCents must be > 0');
  return assertBalanced({
    entryType: 'AP_DISBURSEMENT_RELEASE',
    memo,
    lines: [
      line(apControlId, 'debit', amountCents, locationId, { memo: 'Relieve A/P' }),
      line(paymentsInTransitId, 'credit', amountCents, locationId, { memo: 'Funds in transit' }),
    ],
  });
}

export function buildApSettlementEntry(
  paymentsInTransitId: string,
  operatingBankId: string,
  amountCents: number,
  locationId: string,
  memo = 'AP disbursement settled',
): MoneyMovementEntry {
  if (amountCents <= 0) throw new Error('amountCents must be > 0');
  return assertBalanced({
    entryType: 'AP_DISBURSEMENT_SETTLE',
    memo,
    lines: [
      line(paymentsInTransitId, 'debit', amountCents, locationId, { memo: 'Clear funds in transit' }),
      line(operatingBankId, 'credit', amountCents, locationId, { memo: 'Cash out of bank' }),
    ],
  });
}

export function buildApReturnEntry(
  operatingBankId: string,
  paymentsInTransitId: string,
  amountCents: number,
  locationId: string,
  memo = 'AP disbursement returned/NSF',
): MoneyMovementEntry {
  if (amountCents <= 0) throw new Error('amountCents must be > 0');
  return assertBalanced({
    entryType: 'AP_DISBURSEMENT_RETURN',
    memo,
    lines: [
      line(operatingBankId, 'debit', amountCents, locationId, { memo: 'Funds returned to bank' }),
      line(paymentsInTransitId, 'credit', amountCents, locationId, { memo: 'Reverse in-transit' }),
    ],
  });
}

export function buildApVoidEntry(
  paymentsInTransitId: string,
  apControlId: string,
  amountCents: number,
  locationId: string,
  memo = 'AP disbursement voided (pre-settlement)',
): MoneyMovementEntry {
  if (amountCents <= 0) throw new Error('amountCents must be > 0');
  return assertBalanced({
    entryType: 'AP_DISBURSEMENT_VOID',
    memo,
    lines: [
      line(paymentsInTransitId, 'debit', amountCents, locationId, { memo: 'Reverse in-transit' }),
      line(apControlId, 'credit', amountCents, locationId, { memo: 'Re-establish A/P' }),
    ],
  });
}

// --------------------------------------------------------------------------
// Post wrappers
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
    source_ref: sourceId, // external processor id — string, not a uuid
    created_by: createdBy,
    lines: entry.lines,
  });
}

type ApArgs = { orgId: string; locationId: string; entryDate: string; amountCents: number; createdBy: string | null; sourceId?: string };

export async function postApRelease(supabase: SupabaseClient, a: ApArgs): Promise<PostResult> {
  const [ap, transit] = await Promise.all([
    resolveRole(supabase, a.orgId, 'AP_CONTROL'),
    resolveRole(supabase, a.orgId, 'PAYMENTS_IN_TRANSIT', a.locationId),
  ]);
  return postEntry(supabase, a.orgId, a.locationId, a.entryDate, a.createdBy, buildApReleaseEntry(ap.id, transit.id, a.amountCents, a.locationId), a.sourceId);
}

export async function postApSettlement(supabase: SupabaseClient, a: ApArgs): Promise<PostResult> {
  const [transit, bank] = await Promise.all([
    resolveRole(supabase, a.orgId, 'PAYMENTS_IN_TRANSIT', a.locationId),
    resolveRole(supabase, a.orgId, 'OPERATING_BANK', a.locationId),
  ]);
  return postEntry(supabase, a.orgId, a.locationId, a.entryDate, a.createdBy, buildApSettlementEntry(transit.id, bank.id, a.amountCents, a.locationId), a.sourceId);
}

export async function postApReturn(supabase: SupabaseClient, a: ApArgs): Promise<PostResult> {
  const [bank, transit] = await Promise.all([
    resolveRole(supabase, a.orgId, 'OPERATING_BANK', a.locationId),
    resolveRole(supabase, a.orgId, 'PAYMENTS_IN_TRANSIT', a.locationId),
  ]);
  return postEntry(supabase, a.orgId, a.locationId, a.entryDate, a.createdBy, buildApReturnEntry(bank.id, transit.id, a.amountCents, a.locationId), a.sourceId);
}

export async function postApVoid(supabase: SupabaseClient, a: ApArgs): Promise<PostResult> {
  const [transit, ap] = await Promise.all([
    resolveRole(supabase, a.orgId, 'PAYMENTS_IN_TRANSIT', a.locationId),
    resolveRole(supabase, a.orgId, 'AP_CONTROL'),
  ]);
  return postEntry(supabase, a.orgId, a.locationId, a.entryDate, a.createdBy, buildApVoidEntry(transit.id, ap.id, a.amountCents, a.locationId), a.sourceId);
}
