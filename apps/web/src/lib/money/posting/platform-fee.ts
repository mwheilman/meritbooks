/**
 * Platform fee income posting (Merit-as-platform-operator books).
 *
 * When a tenant collects a payment, the platform earns the application fee.
 * Stripe splits the charge automatically: the tenant's connected account gets
 * (gross - application_fee), the platform balance gets the application_fee, and
 * Stripe deducts its own processing cost from the platform balance.
 *
 * This books that economics onto the PLATFORM operator's own tenant ledger:
 *        DR Payments in Transit   (AF - stripeCost)   net swept to platform bank
 *        DR Merchant/Processing   (stripeCost)        Stripe's cut, an expense
 *        CR Payment Processing Income (AF)            gross fee earned
 *
 * Gated on PLATFORM_ORG_ID — does nothing unless the platform operator org is
 * configured, so ordinary tenant payments are unaffected.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { postJournalEntry, type PostResult } from '@/lib/services/gl-posting';
import { resolveRole } from '@/lib/posting/account-roles';
import { line, assertBalanced, type MoneyMovementEntry } from './types';

export interface PlatformFeeAccounts {
  inTransitId: string;
  processingCostId: string;
  feeIncomeId: string;
}

/** Build the balanced platform-fee income entry (gross fee, Stripe cost, net). */
export function buildPlatformFeeEntry(
  acc: PlatformFeeAccounts,
  grossFeeCents: number,
  stripeCostCents: number,
  locationId: string,
  memo = 'Payment processing income',
): MoneyMovementEntry {
  if (grossFeeCents <= 0) throw new Error('grossFeeCents must be > 0');
  if (stripeCostCents < 0 || stripeCostCents > grossFeeCents) throw new Error('stripeCostCents out of range');
  const netCents = grossFeeCents - stripeCostCents;
  const lines = [
    line(acc.inTransitId, 'debit', netCents, locationId, { memo: 'Net fee to platform bank' }),
    ...(stripeCostCents > 0 ? [line(acc.processingCostId, 'debit', stripeCostCents, locationId, { memo: 'Stripe processing cost' })] : []),
    line(acc.feeIncomeId, 'credit', grossFeeCents, locationId, { memo: 'Application fee earned' }),
  ];
  return assertBalanced({ entryType: 'PLATFORM_FEE', memo, lines });
}

/** Resolve the platform operator's roles and post the fee income entry. */
export async function postPlatformFee(
  supabase: SupabaseClient,
  args: {
    platformOrgId: string; locationId: string; entryDate: string;
    grossFeeCents: number; stripeCostCents: number;
    createdBy: string | null; sourceId?: string; sourceTenantOrgId?: string;
  },
): Promise<PostResult> {
  const [inTransit, cost, income] = await Promise.all([
    resolveRole(supabase, args.platformOrgId, 'PAYMENTS_IN_TRANSIT', args.locationId),
    resolveRole(supabase, args.platformOrgId, 'MERCHANT_FEE_EXPENSE'),
    resolveRole(supabase, args.platformOrgId, 'PLATFORM_FEE_INCOME'),
  ]);
  const entry = buildPlatformFeeEntry(
    { inTransitId: inTransit.id, processingCostId: cost.id, feeIncomeId: income.id },
    args.grossFeeCents,
    args.stripeCostCents,
    args.locationId,
    args.sourceTenantOrgId ? `Payment processing income (tenant ${args.sourceTenantOrgId})` : 'Payment processing income',
  );
  return postJournalEntry(supabase, {
    org_id: args.platformOrgId,
    location_id: args.locationId,
    entry_date: args.entryDate,
    entry_type: 'PLATFORM_FEE',
    memo: entry.memo,
    source_module: 'PLATFORM_FEE',
    source_id: args.sourceId,
    created_by: args.createdBy,
    lines: entry.lines,
  });
}
