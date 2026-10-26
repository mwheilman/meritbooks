/**
 * Scenario levers (AC-CF5) — pure. A scenario never edits the base items; it returns a new list.
 *
 *   DELAY_RECEIPTS       shift AR / recurring-billing receipts by ± days (one customer, or all)
 *   RECEIPT_HAIRCUT      cut those receipts by bps (per item, rounded)
 *   DELAY_DISBURSEMENTS  shift vendor-bill payments by ± days (one vendor, or all)
 *   REMOVE_ITEM          drop one item by key
 *   PAYROLL_GROWTH       ± bps on PROJECTED payroll only (runs on file are never touched)
 *   LINE_DRAW / PAYDOWN  add a dated draw (cash in) / repayment (cash out) on a line, and move
 *                        that company's available headroom by the same amount
 * An adjustment with a company only touches that company's items. Shifted items are clamped to
 * today; items pushed past the horizon leave the forecast (reported as beyond-horizon).
 */

import { addDays, maxIso } from './dates';
import type { Category, ForecastItem } from './types';

export type AdjustmentKind =
  | 'DELAY_RECEIPTS'
  | 'RECEIPT_HAIRCUT'
  | 'DELAY_DISBURSEMENTS'
  | 'REMOVE_ITEM'
  | 'PAYROLL_GROWTH'
  | 'LINE_DRAW'
  | 'LINE_PAYDOWN';

export const ADJUSTMENT_KINDS: readonly AdjustmentKind[] = [
  'DELAY_RECEIPTS',
  'RECEIPT_HAIRCUT',
  'DELAY_DISBURSEMENTS',
  'REMOVE_ITEM',
  'PAYROLL_GROWTH',
  'LINE_DRAW',
  'LINE_PAYDOWN',
];

export interface ScenarioAdjustment {
  id: string;
  kind: AdjustmentKind;
  companyId: string | null;
  customerId?: string | null;
  vendorId?: string | null;
  instrumentId?: string | null;
  itemKey?: string | null;
  days?: number | null;
  bps?: number | null;
  amountCents?: number | null;
  effectiveDate?: string | null;
  label?: string | null;
}

const RECEIPT_CATEGORIES: ReadonlySet<Category> = new Set<Category>(['AR', 'RECURRING_AR']);
const DISBURSEMENT_CATEGORIES: ReadonlySet<Category> = new Set<Category>(['AP']);
const PAYROLL_CATEGORIES: ReadonlySet<Category> = new Set<Category>(['PAYROLL', 'PAYROLL_TAX']);

export interface ScenarioResult {
  items: ForecastItem[];
  /** company → cents drawn (+) / repaid (−) on lines by the scenario. */
  lineMovement: Map<string, number>;
  /** How many items each adjustment touched (UI "affects 12 items"). */
  touched: Map<string, number>;
}

function companyMatch(adj: ScenarioAdjustment, it: ForecastItem): boolean {
  return !adj.companyId || adj.companyId === it.companyId;
}

export function applyScenario(base: readonly ForecastItem[], adjustments: readonly ScenarioAdjustment[], today: string): ScenarioResult {
  let items: ForecastItem[] = base.map((i) => ({ ...i, flags: i.flags ? [...i.flags] : undefined }));
  const lineMovement = new Map<string, number>();
  const touched = new Map<string, number>();
  const bump = (id: string) => touched.set(id, (touched.get(id) ?? 0) + 1);
  const flag = (it: ForecastItem, f: NonNullable<ForecastItem['flags']>[number]) => {
    it.flags = Array.from(new Set([...(it.flags ?? []), f]));
  };

  for (const adj of adjustments) {
    switch (adj.kind) {
      case 'DELAY_RECEIPTS': {
        const days = Math.trunc(adj.days ?? 0);
        if (!days) break;
        for (const it of items) {
          if (it.direction !== 'IN' || !RECEIPT_CATEGORIES.has(it.category) || !companyMatch(adj, it)) continue;
          if (adj.customerId && it.partyId !== adj.customerId) continue;
          it.date = maxIso(addDays(it.date, days), today);
          flag(it, 'DELAYED');
          bump(adj.id);
        }
        break;
      }
      case 'RECEIPT_HAIRCUT': {
        const bps = Math.max(0, Math.min(10_000, Math.trunc(adj.bps ?? 0)));
        if (!bps) break;
        for (const it of items) {
          if (it.direction !== 'IN' || !RECEIPT_CATEGORIES.has(it.category) || !companyMatch(adj, it)) continue;
          if (adj.customerId && it.partyId !== adj.customerId) continue;
          it.amountCents = Math.round((it.amountCents * (10_000 - bps)) / 10_000);
          it.probability = it.grossCents > 0 ? Math.round((it.amountCents / it.grossCents) * 10_000) / 10_000 : 0;
          flag(it, 'HAIRCUT');
          bump(adj.id);
        }
        break;
      }
      case 'DELAY_DISBURSEMENTS': {
        const days = Math.trunc(adj.days ?? 0);
        if (!days) break;
        for (const it of items) {
          if (it.direction !== 'OUT' || !DISBURSEMENT_CATEGORIES.has(it.category) || !companyMatch(adj, it)) continue;
          if (adj.vendorId && it.partyId !== adj.vendorId) continue;
          it.date = maxIso(addDays(it.date, days), today);
          flag(it, 'DELAYED');
          bump(adj.id);
        }
        break;
      }
      case 'REMOVE_ITEM': {
        if (!adj.itemKey) break;
        const before = items.length;
        items = items.filter((it) => it.key !== adj.itemKey);
        if (items.length < before) bump(adj.id);
        break;
      }
      case 'PAYROLL_GROWTH': {
        const bps = Math.trunc(adj.bps ?? 0);
        if (!bps) break;
        for (const it of items) {
          if (!PAYROLL_CATEGORIES.has(it.category) || !it.projected || !companyMatch(adj, it)) continue;
          it.amountCents = Math.max(0, Math.round((it.amountCents * (10_000 + bps)) / 10_000));
          it.grossCents = it.amountCents;
          flag(it, 'GROWTH');
          bump(adj.id);
        }
        break;
      }
      case 'LINE_DRAW':
      case 'LINE_PAYDOWN': {
        const amt = Math.round(adj.amountCents ?? 0);
        if (!(amt > 0) || !adj.companyId || !adj.effectiveDate) break;
        const draw = adj.kind === 'LINE_DRAW';
        items.push({
          key: `scenario:${adj.id}`,
          companyId: adj.companyId,
          direction: draw ? 'IN' : 'OUT',
          category: draw ? 'LINE_DRAW' : 'LINE_PAYDOWN',
          date: maxIso(adj.effectiveDate.slice(0, 10), today),
          amountCents: amt,
          grossCents: amt,
          probability: 1,
          certainty: 'COMMITTED',
          label: adj.label || (draw ? 'Line draw (scenario)' : 'Line paydown (scenario)'),
          party: null,
          partyId: null,
          source: { kind: 'SCENARIO', id: adj.id },
        });
        lineMovement.set(adj.companyId, (lineMovement.get(adj.companyId) ?? 0) + (draw ? amt : -amt));
        bump(adj.id);
        break;
      }
    }
  }
  return { items, lineMovement, touched };
}

/** Preset levers for a new DOWNSIDE / UPSIDE scenario (FPB §4.12). */
export function presetAdjustments(kind: 'DOWNSIDE' | 'UPSIDE' | 'BASE' | 'CUSTOM'): Array<Omit<ScenarioAdjustment, 'id' | 'companyId'>> {
  if (kind === 'DOWNSIDE') {
    return [
      { kind: 'DELAY_RECEIPTS', days: 14, label: 'Customers pay two weeks later' },
      { kind: 'RECEIPT_HAIRCUT', bps: 1000, label: '10% of receipts don’t arrive' },
      { kind: 'PAYROLL_GROWTH', bps: 300, label: 'Payroll 3% higher' },
    ];
  }
  if (kind === 'UPSIDE') return [{ kind: 'DELAY_RECEIPTS', days: -7, label: 'Customers pay a week sooner' }];
  return [];
}
