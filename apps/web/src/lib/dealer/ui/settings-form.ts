/**
 * Dealer Pack (D2, slice C) — the dealer settings form model. Pure and client-safe.
 *
 * Every policy / threshold field of `settingsPatch` (validations/dealer.ts) with a
 * plain-English label, an explanation, its DEFAULT (from defaultSettings — the FPB's),
 * the unit a person types in (days, dollars, percent) and the stored-unit bounds
 * (days, cents, basis points). Conversion never uses floating-point money.
 */

import type { DealerRole } from '../roles';
import { defaultSettings, type DealerSettings } from '../types';
import { centsToInput, money, parseDollarsToCents, pctToBps } from './format';

export type ThresholdUnit = 'days' | 'dollars' | 'percent';

export type NumericSettingKey =
  | 'sot_grace_days'
  | 'term_warning_days'
  | 'interest_tolerance_cents'
  | 'interest_tolerance_bps'
  | 'statement_tolerance_cents'
  | 'auto_match_min_confidence_bps'
  | 'curtailment_warn_days'
  | 'warranty_deadline_warn_days'
  | 'warranty_submitted_aging_days'
  | 'incentive_deadline_warn_days'
  | 'incentive_submitted_aging_days'
  | 'lien_unpaid_days'
  | 'over_allowance_warn_bps'
  | 'line_utilization_warn_bps'
  | 'trade_acv_approval_threshold_cents';

export interface ThresholdField {
  key: NumericSettingKey;
  label: string;
  help: string;
  unit: ThresholdUnit;
  /** Bounds in STORED units (days / cents / bps) — mirror settingsPatch. */
  min: number;
  max: number;
  group: 'Floor plan' | 'Warranty & incentives' | 'Trade-ins' | 'Matching';
}

const MAX_CENTS = 1_000_000_000_000;

export const THRESHOLD_FIELDS: readonly ThresholdField[] = [
  { key: 'sot_grace_days', group: 'Floor plan', unit: 'days', min: 0, max: 30, label: 'Sold-out-of-trust grace', help: 'Days after a payoff falls due before an unpaid sold unit becomes a critical sold-out-of-trust alert.' },
  { key: 'term_warning_days', group: 'Floor plan', unit: 'days', min: 0, max: 3650, label: 'Note maturity warning', help: 'Warn this many days before a floor-plan note reaches the end of its term.' },
  { key: 'curtailment_warn_days', group: 'Floor plan', unit: 'days', min: 0, max: 365, label: 'Curtailment warning', help: 'Warn this many days before a curtailment payment is due.' },
  { key: 'interest_tolerance_cents', group: 'Floor plan', unit: 'dollars', min: 0, max: MAX_CENTS, label: 'Interest tolerance (dollars)', help: 'Billed interest may differ from what Books accrued by the greater of this amount and the percentage below before it needs an approver.' },
  { key: 'interest_tolerance_bps', group: 'Floor plan', unit: 'percent', min: 0, max: 10_000, label: 'Interest tolerance (percent)', help: 'The percentage half of the “greater of” interest tolerance, measured against the accrued interest.' },
  { key: 'line_utilization_warn_bps', group: 'Floor plan', unit: 'percent', min: 0, max: 10_000, label: 'Credit line usage warning', help: 'Warn when a floor-plan line’s balance reaches this share of its credit limit.' },
  { key: 'statement_tolerance_cents', group: 'Matching', unit: 'dollars', min: 0, max: MAX_CENTS, label: 'Statement line tolerance', help: 'A lender statement balance within this amount of Books counts as matched.' },
  { key: 'auto_match_min_confidence_bps', group: 'Matching', unit: 'percent', min: 0, max: 10_000, label: 'Automatic match minimum confidence', help: 'A suggested match must be at least this sure before it can be applied automatically — and only where your autonomy settings allow it. Short-pays never apply automatically.' },
  { key: 'warranty_deadline_warn_days', group: 'Warranty & incentives', unit: 'days', min: 0, max: 365, label: 'Warranty filing deadline warning', help: 'A draft warranty claim turns red this many days before its filing deadline.' },
  { key: 'warranty_submitted_aging_days', group: 'Warranty & incentives', unit: 'days', min: 0, max: 3650, label: 'Warranty unpaid after', help: 'A submitted warranty claim still unpaid after this many days is flagged.' },
  { key: 'incentive_deadline_warn_days', group: 'Warranty & incentives', unit: 'days', min: 0, max: 365, label: 'Incentive claim deadline warning', help: 'An earned incentive not yet claimed is flagged this many days before the program’s claim deadline.' },
  { key: 'incentive_submitted_aging_days', group: 'Warranty & incentives', unit: 'days', min: 0, max: 3650, label: 'Incentive unpaid after', help: 'A claimed incentive still unpaid after this many days is flagged.' },
  { key: 'lien_unpaid_days', group: 'Trade-ins', unit: 'days', min: 0, max: 365, label: 'Trade-in lien unpaid after', help: 'Flag a trade-in whose lien payoff is still owed this many days after the deal.' },
  { key: 'over_allowance_warn_bps', group: 'Trade-ins', unit: 'percent', min: 0, max: 10_000, label: 'Over-allowance warning', help: 'Warn when the trade allowance exceeds the appraised value by more than this share of the appraisal.' },
  { key: 'trade_acv_approval_threshold_cents', group: 'Trade-ins', unit: 'dollars', min: 0, max: MAX_CENTS, label: 'Trade appraisal approval threshold', help: 'Trades appraised at or above this amount need a sales manager’s approval. $0 = every trade needs approval.' },
];

export const THRESHOLD_GROUPS: readonly ThresholdField['group'][] = ['Floor plan', 'Matching', 'Warranty & incentives', 'Trade-ins'];

export const DEFAULTS: DealerSettings = defaultSettings('', '');

/** Stored value → what the input shows. */
export function toDisplay(unit: ThresholdUnit, stored: number): string {
  if (unit === 'dollars') return centsToInput(stored);
  if (unit === 'percent') {
    const whole = Math.trunc(stored / 100);
    const frac = Math.abs(stored % 100);
    return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, '0').replace(/0$/, '')}`;
  }
  return String(stored);
}

/** Human-readable default ("5 days", "$25.00", "2%"). */
export function formatStored(unit: ThresholdUnit, stored: number): string {
  if (unit === 'dollars') return money(stored);
  if (unit === 'percent') return `${toDisplay('percent', stored)}%`;
  return `${stored} day${stored === 1 ? '' : 's'}`;
}

export type Parsed = { ok: true; value: number } | { ok: false; error: string };

/** What the person typed → stored units, validated against the field's bounds. */
export function fromDisplay(f: Pick<ThresholdField, 'unit' | 'min' | 'max'>, text: string): Parsed {
  const t = text.trim();
  if (t === '') return { ok: false, error: 'Required' };
  let v: number | null;
  if (f.unit === 'dollars') {
    v = parseDollarsToCents(t);
    if (v === null) return { ok: false, error: 'Enter a dollar amount like 25.00' };
  } else if (f.unit === 'percent') {
    if (!/^\d+(\.\d{1,2})?%?$/.test(t)) return { ok: false, error: 'Enter a percentage like 2 or 2.5' };
    v = pctToBps(t);
    if (v === null) return { ok: false, error: 'Enter a percentage like 2 or 2.5' };
  } else {
    if (!/^\d+$/.test(t)) return { ok: false, error: 'Enter whole days' };
    v = Number(t);
  }
  if (v < f.min) return { ok: false, error: `Must be at least ${formatStored(f.unit, f.min)}` };
  if (v > f.max) return { ok: false, error: `Must be at most ${formatStored(f.unit, f.max)}` };
  return { ok: true, value: v };
}

/** Aging buckets: 1–8 ascending, distinct, whole days 1..3650 (settingsPatch). */
export function validateBuckets(b: number[]): string | null {
  if (b.length < 1) return 'Keep at least one aging edge.';
  if (b.length > 8) return 'Use at most 8 aging edges.';
  for (const n of b) if (!Number.isInteger(n) || n < 1 || n > 3650) return 'Each edge must be a whole number of days between 1 and 3,650.';
  for (let i = 1; i < b.length; i++) if (b[i] <= b[i - 1]) return 'Edges must be distinct and in ascending order.';
  return null;
}

/** Bucket labels a report shows for these edges ("0–90", "91–180", "365+"). */
export function bucketLabels(b: number[]): string[] {
  const out: string[] = [];
  let lo = 0;
  for (const edge of b) {
    out.push(`${lo}–${edge} days`);
    lo = edge + 1;
  }
  if (b.length) out.push(`over ${b[b.length - 1]} days`);
  return out;
}

export type EditableSettings = Omit<DealerSettings, 'id' | 'org_id' | 'location_id' | 'enabled'>;
export type SettingsPatchBody = Partial<EditableSettings>;

const EDITABLE_KEYS: readonly (keyof EditableSettings)[] = [
  'dms_system',
  'trade_valuation_policy',
  'warranty_recognition',
  'warranty_relieve_parts_inventory',
  'capitalize_setup_labor',
  'cost_reduction_in_stock',
  'oem_settlement_default',
  'sot_grace_days',
  'aging_buckets',
  'term_warning_days',
  'interest_tolerance_cents',
  'interest_tolerance_bps',
  'statement_tolerance_cents',
  'auto_match_min_confidence_bps',
  'curtailment_warn_days',
  'warranty_deadline_warn_days',
  'warranty_submitted_aging_days',
  'incentive_deadline_warn_days',
  'incentive_submitted_aging_days',
  'lien_unpaid_days',
  'over_allowance_warn_bps',
  'line_utilization_warn_bps',
  'trade_acv_approval_threshold_cents',
];

function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i]);
  return a === b;
}

/** Only the fields that changed (PUT /api/dealer/settings sends only these). */
export function settingsDiff(original: DealerSettings, draft: EditableSettings): SettingsPatchBody {
  const out: Record<string, unknown> = {};
  for (const k of EDITABLE_KEYS) {
    let v: unknown = draft[k];
    if (k === 'dms_system') v = typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
    if (!same(v, original[k])) out[k] = v;
  }
  return out as SettingsPatchBody;
}

export function editable(s: DealerSettings): EditableSettings {
  const { id: _id, org_id: _o, location_id: _l, enabled: _e, ...rest } = s;
  return { ...rest, aging_buckets: [...rest.aging_buckets] };
}

// ── accounts screen grouping ──────────────────────────────────────────────────

export const ROLE_GROUPS: ReadonlyArray<{ title: string; roles: readonly DealerRole[] }> = [
  { title: 'Unit inventory', roles: ['WHOLE_GOODS_INVENTORY', 'USED_WHOLE_GOODS_INVENTORY', 'RENTAL_INVENTORY', 'SETUP_LABOR_CAPITALIZED', 'INVENTORY_WRITEDOWN'] },
  { title: 'Floor plan', roles: ['FLOOR_PLAN_PAYABLE', 'FLOOR_PLAN_INTEREST_ACCRUED', 'FLOOR_PLAN_INTEREST', 'FLOOR_PLAN_FEES'] },
  { title: 'Unit sales & cost of sales', roles: ['WHOLE_GOODS_SALES', 'WHOLE_GOODS_COGS', 'USED_GOODS_SALES', 'USED_GOODS_COGS'] },
  { title: 'Trade-ins', roles: ['TRADE_IN_OVER_ALLOWANCE', 'TRADE_LIEN_PAYOFF'] },
  { title: 'Warranty & manufacturer incentives', roles: ['WARRANTY_RECEIVABLE', 'WARRANTY_LABOR_SALES', 'WARRANTY_PARTS_SALES', 'WARRANTY_POLICY_EXPENSE', 'OEM_INCENTIVE_RECEIVABLE', 'CO_OP_ADVERTISING_RECOVERY'] },
  { title: 'Accounts the pack shares with the rest of Books', roles: ['AR_CONTROL', 'AP_CONTROL', 'OPERATING_BANK', 'CUSTOMER_DEPOSITS', 'INVENTORY_ASSET', 'INVENTORY_COGS', 'INTEREST_EXPENSE', 'ACCRUED_EXPENSES', 'SALES_TAX_PAYABLE'] },
];

const ACCOUNT_TYPE_LABEL: Record<string, string> = {
  ASSET: 'an asset',
  LIABILITY: 'a liability',
  EQUITY: 'an equity',
  REVENUE: 'a revenue',
  COGS: 'a cost of sales',
  OPEX: 'an operating expense',
  OTHER: 'an other income / expense',
};

/** "an asset account" / "an operating expense or other income / expense account". */
export function allowedTypesLabel(types: readonly string[]): string {
  const parts = types.map((t) => ACCOUNT_TYPE_LABEL[t] ?? t.toLowerCase());
  return `${parts.join(' or ')} account`;
}

// ── opening tie-out buckets (v_dealer_subledger_tieout) ───────────────────────

export const TIEOUT_BUCKET: Record<string, { label: string; subledger: string }> = {
  FLOOR_PLAN_PAYABLE: { label: 'Floor plan payable', subledger: 'Open floor-plan notes' },
  FLOOR_PLAN_INTEREST_ACCRUED: { label: 'Accrued floor plan interest', subledger: 'Interest accrued, not yet billed' },
  UNIT_INVENTORY: { label: 'Unit inventory', subledger: 'Cost of units in stock' },
  WARRANTY_RECEIVABLE: { label: 'Warranty claims receivable', subledger: 'Open warranty claims' },
  OEM_INCENTIVE_RECEIVABLE: { label: 'Manufacturer incentives receivable', subledger: 'Open incentive claims' },
  TRADE_LIEN_PAYOFF: { label: 'Trade-in lien payoffs owed', subledger: 'Trade liens not yet paid' },
};
