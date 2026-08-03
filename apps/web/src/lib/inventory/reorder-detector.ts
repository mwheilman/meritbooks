/**
 * Inventory reorder alert — a detect-only control on the ai_decisions → /exceptions
 * rail. When an item's on-hand quantity falls to or below its reorder point, this
 * surfaces a PROPOSED exception so a human can replenish it (raise a PO / adjust the
 * point). It NEVER orders stock, moves money, or posts to the ledger — it DETECTS
 * and DRAFTS (canon §3: AI proposes; a human acts). Because /exceptions already
 * folds PROPOSED ai_decisions in as an `ai_proposal` source, an insert here shows up
 * on that queue with no route change.
 *
 * Idempotency: a stable dedup_key `reorder:<item_id>` — a re-scan (or the per-post
 * check) never double-queues, and an already-resolved (APPROVED/REJECTED) alert does
 * not resurface (mirrors EC-1 duplicate-payment exactly).
 *
 * Two entry points share one core:
 *   • scanReorderAlerts     — book-wide sweep (an API route / maintenance pass).
 *   • maybeRaiseReorderAlert — single item, called right after an ISSUE/ADJUST post
 *                              drops on-hand (event-driven, best-effort).
 *
 * All money is bigint cents; confidence is clamped into numeric(5,4).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logAction } from '@/lib/trust/action-log';
import { getTierPolicy, type Tier, type TierPolicy } from '@/lib/trust/score-tier';
import {
  loadAutonomyGovernance,
  decideDisposition,
  type AutonomyGovernance,
} from '@/lib/autonomy/disposition';
import { formatMoney } from '@meritbooks/shared';

export const REORDER_FEATURE = 'INVENTORY_REORDER';

/** Stable, order-independent dedup key for an item's reorder alert. */
export function reorderDedupKey(itemId: string): string {
  return `reorder:${itemId}`;
}

/**
 * PURE. Is this item at/below its reorder point? A null/absent reorder point means
 * "no threshold set" ⇒ never low. Quantities may be fractional.
 */
export function isBelowReorder(qtyOnHand: number, reorderPoint: number | null | undefined): boolean {
  if (reorderPoint == null || !Number.isFinite(reorderPoint)) return false;
  return Number(qtyOnHand) <= Number(reorderPoint);
}

/** Clamp a 0..1 confidence into the numeric(5,4) range the DB column accepts. */
function toConfidence(score: number): number {
  const s = Number.isFinite(score) ? score : 0;
  return Math.max(0, Math.min(0.9999, Math.round(s * 10000) / 10000));
}

interface ItemRow {
  id: string;
  sku: string;
  name: string;
  uom: string | null;
  qty_on_hand: number | string;
  reorder_point: number | string | null;
  avg_cost_cents: number | string;
  location_id: string | null;
  is_active: boolean;
}

const ITEM_COLUMNS =
  'id, sku, name, uom, qty_on_hand, reorder_point, avg_cost_cents, location_id, is_active';

export interface ReorderCandidate {
  itemId: string;
  dedupKey: string;
  title: string;
  reason: string;
  shortfallValueCents: number;
  qtyOnHand: number;
  reorderPoint: number;
  locationId: string | null;
  stockout: boolean; // on-hand ≤ 0 → escalate
}

/** PURE. Build the exception candidate for a low item (null when not actually low). */
export function buildReorderCandidate(item: ItemRow): ReorderCandidate | null {
  const qty = Number(item.qty_on_hand ?? 0);
  const point = item.reorder_point == null ? null : Number(item.reorder_point);
  if (!item.is_active || !isBelowReorder(qty, point)) return null;
  const reorderPoint = Number(point);
  const avg = Number(item.avg_cost_cents ?? 0);
  const shortfallUnits = Math.max(0, reorderPoint - qty);
  const shortfallValueCents = Math.round(shortfallUnits * avg);
  const uom = item.uom || 'unit';
  const stockout = qty <= 0;
  const label = `${item.name} (${item.sku})`;
  return {
    itemId: item.id,
    dedupKey: reorderDedupKey(item.id),
    title: stockout
      ? `Stockout: ${label} — 0 ${uom} on hand`
      : `Low stock: ${label} — ${qty} ${uom} ≤ reorder point ${reorderPoint}`,
    reason: stockout
      ? `${label} is out of stock (on hand ${qty} ${uom}, reorder point ${reorderPoint}). Replenish before the next issue, or on-hand goes negative.`
      : `${label} is at ${qty} ${uom}, at or below its reorder point of ${reorderPoint}. Reorder ~${shortfallUnits} ${uom} to return above the point${shortfallValueCents > 0 ? ` (~${formatMoney(shortfallValueCents)} at current avg cost)` : ''}.`,
    shortfallValueCents,
    qtyOnHand: qty,
    reorderPoint,
    locationId: item.location_id,
    stockout,
  };
}

export interface ReorderScanSummary {
  scanned: number;
  detected: number; // low items found (incl. already-queued)
  queued: number; // NEW exception rows inserted (deduped)
  byTier: Record<Tier, number>;
  errors: number;
}

/** Load the dedup keys of reorder alerts already open OR resolved (idempotency). */
async function loadExistingKeys(db: SupabaseClient): Promise<Set<string>> {
  const keys = new Set<string>();
  try {
    const { data } = await db
      .from('ai_decisions')
      .select('proposed_output')
      .eq('feature', REORDER_FEATURE)
      .in('status', ['PROPOSED', 'APPROVED', 'REJECTED']);
    for (const row of data ?? []) {
      const po = (row as { proposed_output?: { dedup_key?: string } }).proposed_output;
      if (po?.dedup_key) keys.add(po.dedup_key);
    }
  } catch {
    /* best-effort — worst case we may re-queue, never miss */
  }
  return keys;
}

/** Insert one reorder exception + its AI audit row. Returns the tier used, or null on skip/error. */
async function queueReorderException(
  db: SupabaseClient,
  orgId: string,
  gov: AutonomyGovernance,
  policy: TierPolicy,
  c: ReorderCandidate,
): Promise<Tier | null> {
  // A control exception must always reach a human. A stockout is urgent → escalate;
  // otherwise review (never auto — replenishment is a human/PO decision).
  void policy; // reserved: reorder tiering is deterministic, not confidence-graded
  const tier: Tier = c.stockout ? 'escalate' : 'review';
  const confidence = toConfidence(c.stockout ? 0.99 : 0.95);
  const { disposition } = decideDisposition({
    killSwitchEngaged: gov.killSwitchEngaged,
    setting: gov.setting,
    scoreTier: tier,
    amountCents: c.shortfallValueCents,
  });

  const { error } = await db.from('ai_decisions').insert({
    org_id: orgId,
    location_id: c.locationId,
    feature: REORDER_FEATURE,
    input_summary: c.title,
    proposed_output: {
      control: 'INVENTORY_REORDER',
      kind: c.stockout ? 'stockout' : 'low_stock',
      dedup_key: c.dedupKey,
      qty_on_hand: c.qtyOnHand,
      reorder_point: c.reorderPoint,
      shortfall_value_cents: c.shortfallValueCents,
      tier,
      disposition,
      subjects: { inventory_item_id: c.itemId },
      reason: c.reason,
    },
    confidence,
    reasoning: c.reason,
    clarifying_question: 'Raise a purchase order to replenish this item, or adjust its reorder point?',
    status: 'PROPOSED',
    created_by_user: null,
  });
  if (error) {
    console.warn('[inventory/reorder] could not queue exception:', error.message);
    return null;
  }

  await logAction(db, {
    orgId,
    actorType: 'AI',
    actorUserId: null,
    action: 'controls.inventory_reorder.detect',
    subjectTable: 'inventory_items',
    subjectId: c.itemId,
    summary: c.title,
    locationId: c.locationId,
    confidence,
    tier,
    metadata: {
      dedup_key: c.dedupKey,
      qty_on_hand: c.qtyOnHand,
      reorder_point: c.reorderPoint,
      shortfall_value_cents: c.shortfallValueCents,
      stockout: c.stockout,
    },
  });
  return tier;
}

/**
 * Book-wide reorder sweep. Never throws — a control scan must not break the pass it
 * rides on. Returns a summary of what was scanned and newly queued.
 */
export async function scanReorderAlerts(
  db: SupabaseClient,
  orgId: string,
): Promise<ReorderScanSummary> {
  const summary: ReorderScanSummary = {
    scanned: 0,
    detected: 0,
    queued: 0,
    byTier: { auto: 0, review: 0, escalate: 0 },
    errors: 0,
  };

  let policy: TierPolicy;
  try {
    policy = await getTierPolicy(db, orgId);
  } catch {
    policy = { autoThreshold: 0.85, reviewThreshold: 0.7, autoMaxCents: 1_000_000 };
  }
  const gov = await loadAutonomyGovernance(db, orgId, REORDER_FEATURE);

  const { data, error } = await db
    .from('inventory_items')
    .select(ITEM_COLUMNS)
    .eq('is_active', true)
    .not('reorder_point', 'is', null)
    .limit(5000);
  if (error) {
    console.warn('[inventory/reorder] item load failed:', error.message);
    return summary;
  }
  const items = (data ?? []) as ItemRow[];
  summary.scanned = items.length;

  const candidates: ReorderCandidate[] = [];
  for (const it of items) {
    const c = buildReorderCandidate(it);
    if (c) candidates.push(c);
  }
  summary.detected = candidates.length;
  if (candidates.length === 0) return summary;

  const existing = await loadExistingKeys(db);
  for (const c of candidates) {
    if (existing.has(c.dedupKey)) continue;
    const tier = await queueReorderException(db, orgId, gov, policy, c);
    if (tier === null) {
      summary.errors += 1;
      continue;
    }
    existing.add(c.dedupKey);
    summary.queued += 1;
    summary.byTier[tier] += 1;
  }
  return summary;
}

/**
 * Single-item reorder check, called right after a movement drops on-hand. Loads the
 * one item, and if it is now at/below its reorder point (and no alert is already
 * open/resolved for it) queues one. Best-effort and idempotent; safe to call often.
 */
export async function maybeRaiseReorderAlert(
  db: SupabaseClient,
  orgId: string,
  itemId: string,
): Promise<boolean> {
  const { data, error } = await db
    .from('inventory_items')
    .select(ITEM_COLUMNS)
    .eq('id', itemId)
    .maybeSingle();
  if (error || !data) return false;

  const candidate = buildReorderCandidate(data as ItemRow);
  if (!candidate) return false;

  const existing = await loadExistingKeys(db);
  if (existing.has(candidate.dedupKey)) return false;

  let policy: TierPolicy;
  try {
    policy = await getTierPolicy(db, orgId);
  } catch {
    policy = { autoThreshold: 0.85, reviewThreshold: 0.7, autoMaxCents: 1_000_000 };
  }
  const gov = await loadAutonomyGovernance(db, orgId, REORDER_FEATURE);
  const tier = await queueReorderException(db, orgId, gov, policy, candidate);
  return tier !== null;
}
