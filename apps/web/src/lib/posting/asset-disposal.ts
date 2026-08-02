/**
 * Fixed-asset disposal.
 *
 * Disposing an asset removes both its cost and its accumulated depreciation, books
 * any sale proceeds, and recognizes the gain or loss versus net book value:
 *   DR accumulated depreciation  (remove the contra-asset)
 *   DR cash                      (proceeds, if any)
 *   CR asset cost                (remove the asset)
 *   CR gain  OR  DR loss         (balancing — proceeds vs net book value)
 *
 * The gain/loss math and the balanced line plan are PURE (`computeDisposalGainLoss`
 * / `buildDisposalLines`) so they are unit-tested without a database. Direction is
 * explicit (computed from known balances), so the contra-asset accumulated-
 * depreciation account is never mis-signed. The asset is marked DISPOSED with the
 * disposal entry linked. Invalid states (already disposed, negative proceeds) are
 * refused, never posted.
 *
 * Gain (7010) / loss (8010) are resolved by account number today. REPORTED gap:
 * add GAIN_ON_DISPOSAL / LOSS_ON_DISPOSAL to the account-role registry so disposal
 * resolves by ROLE like every other posting path (see account-roles.ts).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { postJournalEntry, type JournalEntryLineInput } from '../services/gl-posting';
import { PostingError } from './account-roles';
import { resolveCashSide } from './account-roles';
import type { PaymentRail } from './transaction-types';

type DB = SupabaseClient;

export const GAIN_ON_DISPOSAL_NUMBER = '7010';
export const LOSS_ON_DISPOSAL_NUMBER = '8010';

export interface DisposeAssetInput {
  orgId: string;
  assetId: string;
  disposalDate: string; // YYYY-MM-DD
  proceedsCents: number; // 0 for an abandonment/write-off
  /** Cash-side account for proceeds; or supply a rail. Ignored when proceeds = 0. */
  cashAccountId?: string;
  rail?: PaymentRail;
  /** Override gain/loss account; defaults to 7010 (gain) / 8010 (loss) by number. */
  gainLossAccountId?: string;
}

interface AssetRow {
  id: string;
  location_id: string;
  name: string;
  acquisition_cost_cents: number;
  accumulated_depreciation_cents: number;
  asset_account_id: string;
  accumulated_depreciation_account_id: string;
  status: string;
}

// ---------------------------------------------------------------------------
// PURE math + line plan (no DB) — unit-tested in asset-disposal.test.ts
// ---------------------------------------------------------------------------

export interface DisposalMath {
  netBookValueCents: number;
  /** >0 gain, <0 loss, 0 breakeven. */
  gainLossCents: number;
  outcome: 'GAIN' | 'LOSS' | 'BREAKEVEN';
}

/** Gain/loss = proceeds − net book value (cost − accumulated depreciation). */
export function computeDisposalGainLoss(
  costCents: number,
  accumulatedCents: number,
  proceedsCents: number
): DisposalMath {
  if (![costCents, accumulatedCents, proceedsCents].every(Number.isInteger)) {
    throw new PostingError('disposal amounts must be integer cents');
  }
  if (proceedsCents < 0) throw new PostingError('proceeds cannot be negative');
  if (costCents < 0 || accumulatedCents < 0) throw new PostingError('cost/accumulated cannot be negative');
  if (accumulatedCents > costCents) throw new PostingError('accumulated depreciation exceeds cost');

  const nbv = costCents - accumulatedCents;
  const gainLoss = proceedsCents - nbv;
  const outcome = gainLoss > 0 ? 'GAIN' : gainLoss < 0 ? 'LOSS' : 'BREAKEVEN';
  return { netBookValueCents: nbv, gainLossCents: gainLoss, outcome };
}

export type DisposalLineRole = 'ACCUMULATED_DEPRECIATION' | 'CASH' | 'ASSET_COST' | 'GAIN' | 'LOSS';

export interface DisposalLinePlan {
  role: DisposalLineRole;
  accountId: string;
  debitCents: number;
  creditCents: number;
  memo: string;
}

export interface BuildDisposalLinesInput {
  assetName: string;
  costCents: number;
  accumulatedCents: number;
  proceedsCents: number;
  assetAccountId: string;
  accumDepAccountId: string;
  /** Required when proceeds > 0. */
  cashAccountId?: string;
  /** Required when the disposal produces a gain. */
  gainAccountId?: string;
  /** Required when the disposal produces a loss. */
  lossAccountId?: string;
}

/**
 * Build the balanced disposal line plan. Debits always equal credits by
 * construction; the gain/loss line is the balancing figure.
 */
export function buildDisposalLines(input: BuildDisposalLinesInput): {
  lines: DisposalLinePlan[];
  math: DisposalMath;
} {
  const math = computeDisposalGainLoss(input.costCents, input.accumulatedCents, input.proceedsCents);
  const lines: DisposalLinePlan[] = [];

  // Remove accumulated depreciation (contra-asset, normal credit → debit to clear).
  if (input.accumulatedCents > 0) {
    lines.push({
      role: 'ACCUMULATED_DEPRECIATION',
      accountId: input.accumDepAccountId,
      debitCents: input.accumulatedCents,
      creditCents: 0,
      memo: 'Remove accumulated depreciation',
    });
  }
  // Proceeds into cash.
  if (input.proceedsCents > 0) {
    if (!input.cashAccountId) throw new PostingError('Provide a cash-side account (or rail) for the sale proceeds');
    lines.push({
      role: 'CASH',
      accountId: input.cashAccountId,
      debitCents: input.proceedsCents,
      creditCents: 0,
      memo: 'Disposal proceeds',
    });
  }
  // Remove the asset at cost.
  lines.push({
    role: 'ASSET_COST',
    accountId: input.assetAccountId,
    debitCents: 0,
    creditCents: input.costCents,
    memo: `Dispose ${input.assetName}`,
  });
  // Gain or loss balances the entry.
  if (math.outcome === 'GAIN') {
    if (!input.gainAccountId) throw new PostingError('No gain-on-disposal account resolved');
    lines.push({ role: 'GAIN', accountId: input.gainAccountId, debitCents: 0, creditCents: math.gainLossCents, memo: 'Gain on disposal' });
  } else if (math.outcome === 'LOSS') {
    if (!input.lossAccountId) throw new PostingError('No loss-on-disposal account resolved');
    lines.push({ role: 'LOSS', accountId: input.lossAccountId, debitCents: -math.gainLossCents, creditCents: 0, memo: 'Loss on disposal' });
  }

  const totalDebit = lines.reduce((s, l) => s + l.debitCents, 0);
  const totalCredit = lines.reduce((s, l) => s + l.creditCents, 0);
  if (totalDebit !== totalCredit) {
    throw new PostingError(`disposal plan unbalanced: debits=${totalDebit} credits=${totalCredit}`);
  }
  return { lines, math };
}

// ---------------------------------------------------------------------------
// DB-facing preview + commit
// ---------------------------------------------------------------------------

async function acctByNumber(db: DB, orgId: string, number: string): Promise<string | null> {
  const { data } = await db.from('accounts').select('id').eq('org_id', orgId).eq('account_number', number).eq('is_active', true).maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

async function loadAsset(db: DB, orgId: string, assetId: string): Promise<AssetRow> {
  const { data, error } = await db
    .from('fixed_assets')
    .select('id, location_id, name, acquisition_cost_cents, accumulated_depreciation_cents, asset_account_id, accumulated_depreciation_account_id, status')
    .eq('org_id', orgId)
    .eq('id', assetId)
    .single<AssetRow>();
  if (error || !data) throw new PostingError('Fixed asset not found');
  return data;
}

async function resolveDisposalAccounts(db: DB, input: DisposeAssetInput, asset: AssetRow, needGain: boolean, needLoss: boolean) {
  let cashAccountId: string | undefined;
  if (input.proceedsCents > 0) {
    cashAccountId = input.cashAccountId ?? (input.rail ? (await resolveCashSide(db, input.orgId, input.rail, asset.location_id)).id : undefined);
    if (!cashAccountId) throw new PostingError('Provide cashAccountId or rail for the sale proceeds');
  }
  let gainAccountId: string | undefined;
  let lossAccountId: string | undefined;
  if (needGain) {
    gainAccountId = input.gainLossAccountId ?? (await acctByNumber(db, input.orgId, GAIN_ON_DISPOSAL_NUMBER)) ?? undefined;
    if (!gainAccountId) throw new PostingError(`No gain-on-disposal account (${GAIN_ON_DISPOSAL_NUMBER}) found — map GAIN_ON_DISPOSAL or seed the account`);
  }
  if (needLoss) {
    lossAccountId = input.gainLossAccountId ?? (await acctByNumber(db, input.orgId, LOSS_ON_DISPOSAL_NUMBER)) ?? undefined;
    if (!lossAccountId) throw new PostingError(`No loss-on-disposal account (${LOSS_ON_DISPOSAL_NUMBER}) found — map LOSS_ON_DISPOSAL or seed the account`);
  }
  return { cashAccountId, gainAccountId, lossAccountId };
}

export interface DisposalPreviewResult {
  asset_id: string;
  asset_name: string;
  cost_cents: number;
  accumulated_depreciation_cents: number;
  net_book_value_cents: number;
  proceeds_cents: number;
  gain_loss_cents: number;
  outcome: 'GAIN' | 'LOSS' | 'BREAKEVEN';
  lines: DisposalLinePlan[];
}

/** Compute the gain/loss and the exact balanced entry WITHOUT posting anything. */
export async function previewAssetDisposal(db: DB, input: DisposeAssetInput): Promise<DisposalPreviewResult> {
  const asset = await loadAsset(db, input.orgId, input.assetId);
  if (asset.status === 'DISPOSED') throw new PostingError('Asset is already disposed');

  const math = computeDisposalGainLoss(asset.acquisition_cost_cents, asset.accumulated_depreciation_cents, input.proceedsCents);
  const accts = await resolveDisposalAccounts(db, input, asset, math.outcome === 'GAIN', math.outcome === 'LOSS');
  const { lines } = buildDisposalLines({
    assetName: asset.name,
    costCents: asset.acquisition_cost_cents,
    accumulatedCents: asset.accumulated_depreciation_cents,
    proceedsCents: input.proceedsCents,
    assetAccountId: asset.asset_account_id,
    accumDepAccountId: asset.accumulated_depreciation_account_id,
    cashAccountId: accts.cashAccountId,
    gainAccountId: accts.gainAccountId,
    lossAccountId: accts.lossAccountId,
  });

  return {
    asset_id: asset.id,
    asset_name: asset.name,
    cost_cents: asset.acquisition_cost_cents,
    accumulated_depreciation_cents: asset.accumulated_depreciation_cents,
    net_book_value_cents: math.netBookValueCents,
    proceeds_cents: input.proceedsCents,
    gain_loss_cents: math.gainLossCents,
    outcome: math.outcome,
    lines,
  };
}

export interface DisposeAssetResult {
  asset_id: string;
  gl_entry_id: string | null;
  gain_loss_cents: number; // positive = gain, negative = loss
  net_book_value_cents: number;
}

export async function recordAssetDisposal(db: DB, input: DisposeAssetInput): Promise<DisposeAssetResult> {
  if (!input.disposalDate) throw new PostingError('disposalDate is required');
  const asset = await loadAsset(db, input.orgId, input.assetId);
  if (asset.status === 'DISPOSED') throw new PostingError('Asset is already disposed');

  const math = computeDisposalGainLoss(asset.acquisition_cost_cents, asset.accumulated_depreciation_cents, input.proceedsCents);
  const accts = await resolveDisposalAccounts(db, input, asset, math.outcome === 'GAIN', math.outcome === 'LOSS');
  const { lines: plan } = buildDisposalLines({
    assetName: asset.name,
    costCents: asset.acquisition_cost_cents,
    accumulatedCents: asset.accumulated_depreciation_cents,
    proceedsCents: input.proceedsCents,
    assetAccountId: asset.asset_account_id,
    accumDepAccountId: asset.accumulated_depreciation_account_id,
    cashAccountId: accts.cashAccountId,
    gainAccountId: accts.gainAccountId,
    lossAccountId: accts.lossAccountId,
  });

  const lines: JournalEntryLineInput[] = plan.map((l) => ({
    account_id: l.accountId,
    debit_cents: l.debitCents,
    credit_cents: l.creditCents,
    location_id: asset.location_id,
    memo: l.memo,
  }));

  const je = await postJournalEntry(db, {
    org_id: input.orgId,
    location_id: asset.location_id,
    entry_date: input.disposalDate,
    entry_type: 'STANDARD',
    memo: `Asset disposal — ${asset.name}`,
    source_module: 'FIXED_ASSET',
    source_id: asset.id,
    created_by: null,
    lines,
  });
  if (!je.success || !je.entry_id) throw new PostingError(je.error ?? 'Failed to post disposal');

  await db
    .from('fixed_assets')
    .update({
      status: 'DISPOSED',
      disposal_date: input.disposalDate,
      disposal_proceeds_cents: input.proceedsCents,
      disposal_gl_entry_id: je.entry_id,
      updated_at: new Date().toISOString(),
    })
    .eq('id', asset.id);

  return {
    asset_id: asset.id,
    gl_entry_id: je.entry_id,
    gain_loss_cents: math.gainLossCents,
    net_book_value_cents: math.netBookValueCents,
  };
}
