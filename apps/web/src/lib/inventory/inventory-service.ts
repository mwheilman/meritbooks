/**
 * Inventory service (GATE 11c) — the seam between the pure valuation engine and
 * the ledger. Mirrors the provisioning/lifecycle pattern: the engine stays pure,
 * the side effects (movement rows, item rollups, GL posts) live here.
 *
 * POSTING POSTURE (canon §3 — no auto-post):
 *   RECEIPT  — records on-hand + value only; posts NOTHING to the GL. Receiving is
 *              not a GL event in this build (the linked bill/cash entry books the
 *              inventory asset, exactly as goods-receipts leaves posting to the
 *              bill). Standalone-safe: a receipt with no bill is a subledger fact.
 *   ISSUE    — the GL event. Created PROPOSED with a computed COGS snapshot; a human
 *              approves, and only then does it post DR COGS / CR Inventory Asset,
 *              resolved BY ROLE through the deterministic engine. Never auto-posts.
 *   ADJUST   — same human gate as ISSUE. A write-down (negative) posts DR COGS /
 *              CR Inventory; a write-up (positive) posts DR Inventory / CR COGS.
 *
 * Accounts resolve BY ROLE (INVENTORY_ASSET / INVENTORY_COGS) unless the item
 * carries an explicit override account. Money is bigint cents; debits/credits are
 * DERIVED from account type via debitCreditFor — never passed in.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { postJournalEntry } from '../services/gl-posting';
import { debitCreditFor } from '../posting/account-direction';
import {
  resolveRole,
  getAccountRef,
  PostingError,
  type AccountRef,
} from '../posting/account-roles';
import {
  applyReceipt,
  applyIssue,
  applyAdjust,
  unitAverageCents,
  ValuationError,
  type ValuationMethod,
  type ValuationState,
  type FifoLayer,
  type MovementResult,
} from './valuation';

type DB = SupabaseClient;

interface ItemRow {
  id: string;
  org_id: string;
  location_id: string | null;
  valuation_method: ValuationMethod;
  qty_on_hand: number;
  avg_cost_cents: number;
  total_value_cents: number;
  fifo_layers: FifoLayer[] | null;
  asset_account_id: string | null;
  cogs_account_id: string | null;
  is_active: boolean;
}

/** Rebuild the pure valuation state from an item's persisted columns. */
function stateFromRow(row: ItemRow): ValuationState {
  return {
    qty_on_hand: Number(row.qty_on_hand ?? 0),
    avg_cost_cents: Number(row.avg_cost_cents ?? 0),
    total_value_cents: Number(row.total_value_cents ?? 0),
    fifo_layers: Array.isArray(row.fifo_layers)
      ? row.fifo_layers.map((l) => ({ qty: Number(l.qty), value_cents: Number(l.value_cents) }))
      : [],
  };
}

/** Persist a new valuation state back onto the item. */
async function writeState(db: DB, orgId: string, itemId: string, state: ValuationState): Promise<void> {
  const { error } = await db
    .from('inventory_items')
    .update({
      qty_on_hand: state.qty_on_hand,
      avg_cost_cents: state.avg_cost_cents,
      total_value_cents: state.total_value_cents,
      fifo_layers: state.fifo_layers,
      updated_at: new Date().toISOString(),
    })
    .eq('org_id', orgId)
    .eq('id', itemId);
  if (error) throw new PostingError(`Failed to update item valuation: ${error.message}`);
}

async function loadItem(db: DB, orgId: string, itemId: string): Promise<ItemRow> {
  const { data, error } = await db
    .from('inventory_items')
    .select(
      'id, org_id, location_id, valuation_method, qty_on_hand, avg_cost_cents, total_value_cents, fifo_layers, asset_account_id, cogs_account_id, is_active',
    )
    .eq('org_id', orgId)
    .eq('id', itemId)
    .maybeSingle<ItemRow>();
  if (error) throw new PostingError(`Item lookup failed: ${error.message}`);
  if (!data) throw new PostingError('Inventory item not found');
  return data;
}

/** The GL accounts an inventory post touches: the asset carried and its COGS. */
async function resolveAccounts(
  db: DB,
  orgId: string,
  item: ItemRow,
): Promise<{ asset: AccountRef; cogs: AccountRef }> {
  const asset = item.asset_account_id
    ? await getAccountRef(db, orgId, item.asset_account_id)
    : await resolveRole(db, orgId, 'INVENTORY_ASSET');
  const cogs = item.cogs_account_id
    ? await getAccountRef(db, orgId, item.cogs_account_id)
    : await resolveRole(db, orgId, 'INVENTORY_COGS');
  return { asset, cogs };
}

// ---------------------------------------------------------------------------
// RECEIPT — valuation only, no GL
// ---------------------------------------------------------------------------

export interface ReceiveInput {
  orgId: string;
  itemId: string;
  qty: number;
  totalCostCents: number;
  receivedDate: string; // YYYY-MM-DD
  reference?: string | null;
  refType?: string | null; // 'BILL' | 'PO' | 'MANUAL'
  refId?: string | null;
  memo?: string | null;
  createdBy?: string | null;
}

export interface MovementRecord {
  movement_id: string;
  status: 'PROPOSED' | 'POSTED';
  cogs_cents: number;
  gl_entry_id: string | null;
  qty_on_hand: number;
  avg_cost_cents: number;
  total_value_cents: number;
}

export async function receiveInventory(db: DB, input: ReceiveInput): Promise<MovementRecord> {
  const item = await loadItem(db, input.orgId, input.itemId);
  if (!item.is_active) throw new PostingError('Cannot receive against an inactive item');

  let result: MovementResult;
  try {
    result = applyReceipt(stateFromRow(item), input.qty, input.totalCostCents);
  } catch (e) {
    throw e instanceof ValuationError ? new PostingError(e.message) : e;
  }

  const { data: mv, error } = await db
    .from('inventory_movements')
    .insert({
      org_id: input.orgId,
      item_id: input.itemId,
      location_id: item.location_id,
      movement_type: 'RECEIPT',
      status: 'POSTED', // a receipt is a recorded fact, not a GL post
      qty: input.qty,
      unit_cost_cents: result.unit_cost_cents,
      total_cost_cents: input.totalCostCents,
      cogs_cents: 0,
      reference: input.reference ?? null,
      ref_type: input.refType ?? 'MANUAL',
      ref_id: input.refId ?? null,
      memo: input.memo ?? null,
      movement_date: input.receivedDate,
      gl_entry_id: null,
      posted_at: new Date().toISOString(),
      created_by: input.createdBy ?? null,
    })
    .select('id')
    .single();
  if (error || !mv) throw new PostingError(error?.message ?? 'Failed to record receipt');

  await writeState(db, input.orgId, input.itemId, result.state);

  return {
    movement_id: mv.id as string,
    status: 'POSTED',
    cogs_cents: 0,
    gl_entry_id: null,
    qty_on_hand: result.state.qty_on_hand,
    avg_cost_cents: unitAverageCents(result.state),
    total_value_cents: result.state.total_value_cents,
  };
}

// ---------------------------------------------------------------------------
// ISSUE / ADJUST — proposed, then human-approved GL post
// ---------------------------------------------------------------------------

export interface ProposeMovementInput {
  orgId: string;
  itemId: string;
  type: 'ISSUE' | 'ADJUST';
  /** ISSUE: units to remove (positive). ADJUST: signed delta (+write-up / −write-down). */
  qty: number;
  /** Required for a positive ADJUST (write-up unit cost, cents). */
  unitCostCents?: number;
  movementDate: string; // YYYY-MM-DD
  reference?: string | null;
  memo?: string | null;
  createdBy?: string | null;
}

/**
 * Create a PROPOSED movement carrying a COGS *preview* computed from live state.
 * Nothing is posted and on-hand is NOT mutated — a human approves via
 * postProposedMovement, which recomputes against live state before posting.
 */
export async function proposeMovement(db: DB, input: ProposeMovementInput): Promise<MovementRecord> {
  const item = await loadItem(db, input.orgId, input.itemId);
  if (!item.is_active) throw new PostingError('Cannot move an inactive item');

  const state = stateFromRow(item);
  let preview: MovementResult;
  try {
    preview =
      input.type === 'ISSUE'
        ? applyIssue(item.valuation_method, state, input.qty)
        : applyAdjust(item.valuation_method, state, input.qty, input.unitCostCents);
  } catch (e) {
    throw e instanceof ValuationError ? new PostingError(e.message) : e;
  }

  const { data: mv, error } = await db
    .from('inventory_movements')
    .insert({
      org_id: input.orgId,
      item_id: input.itemId,
      location_id: item.location_id,
      movement_type: input.type,
      status: 'PROPOSED',
      qty: input.qty,
      unit_cost_cents: preview.unit_cost_cents,
      total_cost_cents: input.type === 'ADJUST' && input.qty > 0 ? Math.round((input.unitCostCents ?? 0) * input.qty) : preview.cogs_cents,
      cogs_cents: preview.cogs_cents,
      reference: input.reference ?? null,
      ref_type: 'MANUAL',
      memo: input.memo ?? null,
      movement_date: input.movementDate,
      gl_entry_id: null,
      created_by: input.createdBy ?? null,
    })
    .select('id')
    .single();
  if (error || !mv) throw new PostingError(error?.message ?? 'Failed to propose movement');

  return {
    movement_id: mv.id as string,
    status: 'PROPOSED',
    cogs_cents: preview.cogs_cents,
    gl_entry_id: null,
    // Preview of the resulting state (not yet persisted).
    qty_on_hand: preview.state.qty_on_hand,
    avg_cost_cents: unitAverageCents(preview.state),
    total_value_cents: preview.state.total_value_cents,
  };
}

interface MovementRow {
  id: string;
  item_id: string;
  location_id: string | null;
  movement_type: 'RECEIPT' | 'ISSUE' | 'ADJUST';
  status: 'PROPOSED' | 'POSTED' | 'VOID';
  qty: number;
  unit_cost_cents: number;
  memo: string | null;
  movement_date: string;
}

/**
 * Approve + post a PROPOSED ISSUE/ADJUST. Recomputes COGS from LIVE state (the
 * source of truth), mutates on-hand, and posts a balanced entry BY ROLE:
 *   write-down / issue → DR COGS / CR Inventory Asset
 *   write-up (positive adjust) → DR Inventory Asset / CR COGS
 */
export async function postProposedMovement(
  db: DB,
  orgId: string,
  movementId: string,
  opts: { postedBy?: string | null } = {},
): Promise<MovementRecord> {
  const { data: mvRow, error: mvErr } = await db
    .from('inventory_movements')
    .select('id, item_id, location_id, movement_type, status, qty, unit_cost_cents, memo, movement_date')
    .eq('org_id', orgId)
    .eq('id', movementId)
    .maybeSingle<MovementRow>();
  if (mvErr) throw new PostingError(`Movement lookup failed: ${mvErr.message}`);
  if (!mvRow) throw new PostingError('Movement not found');
  if (mvRow.status !== 'PROPOSED') throw new PostingError(`Movement is ${mvRow.status}, not PROPOSED`);
  if (mvRow.movement_type === 'RECEIPT') throw new PostingError('Receipts are not posted through this gate');

  const item = await loadItem(db, orgId, mvRow.item_id);
  const locationId = mvRow.location_id ?? item.location_id;
  if (!locationId) throw new PostingError('Movement has no location; cannot post to a fiscal period');

  const state = stateFromRow(item);
  const isAdjust = mvRow.movement_type === 'ADJUST';
  const signedQty = Number(mvRow.qty);
  const writeUp = isAdjust && signedQty > 0;

  let result: MovementResult;
  try {
    result = isAdjust
      ? applyAdjust(item.valuation_method, state, signedQty, writeUp ? mvRow.unit_cost_cents : undefined)
      : applyIssue(item.valuation_method, state, signedQty);
  } catch (e) {
    throw e instanceof ValuationError ? new PostingError(e.message) : e;
  }

  const amount = writeUp
    ? Math.round(mvRow.unit_cost_cents * signedQty) // value added on a write-up
    : result.cogs_cents; // COGS removed on an issue / write-down
  if (amount <= 0) throw new PostingError('Movement has no value to post');

  const { asset, cogs } = await resolveAccounts(db, orgId, item);

  // Derive both legs from account type + intended effect (never hard-code Dr/Cr).
  const assetEffect = writeUp ? 'increase' : 'decrease';
  const cogsEffect = writeUp ? 'decrease' : 'increase';
  const lines = [
    {
      account_id: cogs.id,
      ...debitCreditFor(cogs.account_type, cogsEffect, amount, cogs.account_sub_type),
      location_id: locationId,
      memo: mvRow.memo ?? (isAdjust ? 'Inventory adjustment' : 'Inventory issue (COGS)'),
    },
    {
      account_id: asset.id,
      ...debitCreditFor(asset.account_type, assetEffect, amount, asset.account_sub_type),
      location_id: locationId,
      memo: 'Inventory on hand',
    },
  ];

  const je = await postJournalEntry(db, {
    org_id: orgId,
    location_id: locationId,
    entry_date: mvRow.movement_date,
    entry_type: 'STANDARD',
    memo: mvRow.memo ?? (isAdjust ? 'Inventory adjustment' : 'Inventory issue'),
    source_module: 'INVENTORY',
    source_id: movementId,
    created_by: null,
    lines,
  });
  if (!je.success || !je.entry_id) throw new PostingError(je.error ?? 'Failed to post inventory entry');

  await writeState(db, orgId, mvRow.item_id, result.state);
  const { error: updErr } = await db
    .from('inventory_movements')
    .update({
      status: 'POSTED',
      cogs_cents: result.cogs_cents,
      gl_entry_id: je.entry_id,
      posted_at: new Date().toISOString(),
      posted_by: opts.postedBy ?? null,
    })
    .eq('org_id', orgId)
    .eq('id', movementId);
  if (updErr) throw new PostingError(`GL posted but movement update failed: ${updErr.message}`);

  return {
    movement_id: movementId,
    status: 'POSTED',
    cogs_cents: result.cogs_cents,
    gl_entry_id: je.entry_id,
    qty_on_hand: result.state.qty_on_hand,
    avg_cost_cents: unitAverageCents(result.state),
    total_value_cents: result.state.total_value_cents,
  };
}
