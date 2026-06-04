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
 * Direction here is explicit (computed from known balances), so the contra-asset
 * accumulated-depreciation account is never mis-signed. The asset is marked
 * DISPOSED with the disposal entry linked.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { postJournalEntry, type JournalEntryLineInput } from '../services/gl-posting';
import { PostingError } from './account-roles';
import { resolveCashSide } from './account-roles';
import type { PaymentRail } from './transaction-types';

type DB = SupabaseClient;

export interface DisposeAssetInput {
  orgId: string;
  assetId: string;
  disposalDate: string; // YYYY-MM-DD
  proceedsCents: number; // 0 for an abandonment/write-off
  /** Cash-side account for proceeds; or supply a rail. Ignored when proceeds = 0. */
  cashAccountId?: string;
  rail?: PaymentRail;
  /** Override gain/loss account; defaults to standard 7010 (gain) / 8010 (loss). */
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

async function acctByNumber(db: DB, orgId: string, number: string): Promise<string | null> {
  const { data } = await db.from('accounts').select('id').eq('org_id', orgId).eq('account_number', number).eq('is_active', true).maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

export interface DisposeAssetResult {
  asset_id: string;
  gl_entry_id: string | null;
  gain_loss_cents: number; // positive = gain, negative = loss
  net_book_value_cents: number;
}

export async function recordAssetDisposal(db: DB, input: DisposeAssetInput): Promise<DisposeAssetResult> {
  const { data, error } = await db
    .from('fixed_assets')
    .select('id, location_id, name, acquisition_cost_cents, accumulated_depreciation_cents, asset_account_id, accumulated_depreciation_account_id, status')
    .eq('org_id', input.orgId)
    .eq('id', input.assetId)
    .single<AssetRow>();
  if (error || !data) throw new PostingError('Fixed asset not found');
  if (data.status === 'DISPOSED') throw new PostingError('Asset is already disposed');

  const cost = data.acquisition_cost_cents;
  const accumulated = data.accumulated_depreciation_cents;
  const nbv = cost - accumulated;
  const proceeds = input.proceedsCents;
  const gainLoss = proceeds - nbv; // >0 gain, <0 loss

  const lines: JournalEntryLineInput[] = [];
  // Remove accumulated depreciation (contra-asset, normal credit → debit to clear).
  if (accumulated > 0) {
    lines.push({ account_id: data.accumulated_depreciation_account_id, debit_cents: accumulated, credit_cents: 0, location_id: data.location_id, memo: 'Remove accumulated depreciation' });
  }
  // Proceeds into cash.
  if (proceeds > 0) {
    const cashId = input.cashAccountId ?? (input.rail ? (await resolveCashSide(db, input.orgId, input.rail, data.location_id)).id : null);
    if (!cashId) throw new PostingError('Provide cashAccountId or rail for the sale proceeds');
    lines.push({ account_id: cashId, debit_cents: proceeds, credit_cents: 0, location_id: data.location_id, memo: 'Disposal proceeds' });
  }
  // Remove the asset at cost.
  lines.push({ account_id: data.asset_account_id, debit_cents: 0, credit_cents: cost, location_id: data.location_id, memo: `Dispose ${data.name}` });

  // Gain or loss balances the entry.
  if (gainLoss !== 0) {
    const isGain = gainLoss > 0;
    const glAccount = input.gainLossAccountId ?? (await acctByNumber(db, input.orgId, isGain ? '7010' : '8010'));
    if (!glAccount) throw new PostingError(`No ${isGain ? 'gain (7010)' : 'loss (8010)'} on sale of assets account found`);
    if (isGain) {
      lines.push({ account_id: glAccount, debit_cents: 0, credit_cents: gainLoss, location_id: data.location_id, memo: 'Gain on disposal' });
    } else {
      lines.push({ account_id: glAccount, debit_cents: -gainLoss, credit_cents: 0, location_id: data.location_id, memo: 'Loss on disposal' });
    }
  }

  const je = await postJournalEntry(db, {
    org_id: input.orgId,
    location_id: data.location_id,
    entry_date: input.disposalDate,
    entry_type: 'STANDARD',
    memo: `Asset disposal — ${data.name}`,
    source_module: 'FIXED_ASSET',
    source_id: data.id,
    created_by: null,
    lines,
  });
  if (!je.success || !je.entry_id) throw new PostingError(je.error ?? 'Failed to post disposal');

  await db
    .from('fixed_assets')
    .update({
      status: 'DISPOSED',
      disposal_date: input.disposalDate,
      disposal_proceeds_cents: proceeds,
      disposal_gl_entry_id: je.entry_id,
      updated_at: new Date().toISOString(),
    })
    .eq('id', data.id);

  return { asset_id: data.id, gl_entry_id: je.entry_id, gain_loss_cents: gainLoss, net_book_value_cents: nbv };
}
