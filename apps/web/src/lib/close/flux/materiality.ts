/**
 * Flux materiality (FPB-financial-reports §5 A-3E.1) — pure, exhaustively unit-tested.
 *
 *   • `policyFromRow` / `DEFAULT_FLUX_POLICY` — a stored policy row → `FluxPolicy`.
 *   • `resolveThreshold(policy, account)` — the threshold that applies to one account:
 *     policy → TYPE override → GROUP override → ACCOUNT override (most specific wins,
 *     field by field), plus outright exclusions.
 *   • `pctChangeBps(change, comparison)` — basis points, null on a zero base.
 *   • `evaluateMateriality(change, pct, threshold)` — material? and which tests breached.
 *
 * Zero-base rule: the % test cannot breach when the comparison is 0 (the % is undefined).
 * `EITHER` still breaches on $; `BOTH` falls back to the $ test alone; `PCT_ONLY` cannot
 * breach (documented: choose EITHER if a brand-new line must always surface).
 */

import type {
  BreachReason,
  ComparisonBasis,
  FluxAccount,
  FluxDimension,
  FluxPolicy,
  MaterialityOverride,
  OverrideScope,
  ResolvedThreshold,
  ThresholdMode,
} from './types';
import { COMPARISON_BASES, FLUX_DIMENSIONS, THRESHOLD_MODES } from './types';

export const DEFAULT_FLUX_POLICY: FluxPolicy = {
  id: null,
  source: 'DEFAULT',
  locationId: null,
  reviewRequired: true,
  thresholdMode: 'EITHER',
  absThresholdCents: 500_000,
  pctThresholdBps: 1_000,
  comparisonBasis: 'PRIOR_MONTH',
  dimension: 'ACCOUNT',
  includePnl: true,
  includeBalanceSheet: true,
  overrides: [],
  excludedAccountIds: [],
  updatedAt: null,
  updatedBy: null,
};

/** The stored row shape (public.flux_materiality_policies). */
export interface FluxPolicyRow {
  id: string;
  location_id: string | null;
  review_required: boolean;
  threshold_mode: string;
  abs_threshold_cents: number | string;
  pct_threshold_bps: number | string;
  comparison_basis: string;
  dimension: string;
  include_pnl: boolean;
  include_balance_sheet: boolean;
  overrides: unknown;
  excluded_account_ids: string[] | null;
  updated_at: string | null;
  updated_by: string | null;
}

const int = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

const SCOPES: readonly OverrideScope[] = ['TYPE', 'GROUP', 'ACCOUNT'];

/** Parse one stored override; invalid entries are dropped (they can never widen anything). */
export function parseOverride(raw: unknown): MaterialityOverride | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const scope = oneOf<OverrideScope | ''>(o.scope, SCOPES, '');
  if (!scope || typeof o.key !== 'string' || o.key.length === 0) return null;
  const abs = o.absThresholdCents == null ? null : int(o.absThresholdCents, -1);
  const pct = o.pctThresholdBps == null ? null : int(o.pctThresholdBps, -1);
  if ((abs !== null && abs < 0) || (pct !== null && pct < 0)) return null;
  const mode = o.mode == null ? null : oneOf<ThresholdMode | ''>(o.mode, THRESHOLD_MODES, '');
  if (mode === '') return null;
  return {
    scope,
    key: o.key,
    absThresholdCents: abs,
    pctThresholdBps: pct,
    mode,
    excluded: typeof o.excluded === 'boolean' ? o.excluded : null,
  };
}

export function policyFromRow(row: FluxPolicyRow | null, source: 'COMPANY' | 'TENANT'): FluxPolicy {
  if (!row) return DEFAULT_FLUX_POLICY;
  const overrides = Array.isArray(row.overrides)
    ? (row.overrides as unknown[]).map(parseOverride).filter((x): x is MaterialityOverride => x !== null)
    : [];
  return {
    id: row.id,
    source,
    locationId: row.location_id,
    reviewRequired: row.review_required !== false,
    thresholdMode: oneOf<ThresholdMode>(row.threshold_mode, THRESHOLD_MODES, 'EITHER'),
    absThresholdCents: Math.max(0, int(row.abs_threshold_cents, DEFAULT_FLUX_POLICY.absThresholdCents)),
    pctThresholdBps: Math.max(0, int(row.pct_threshold_bps, DEFAULT_FLUX_POLICY.pctThresholdBps)),
    comparisonBasis: oneOf<ComparisonBasis>(row.comparison_basis, COMPARISON_BASES, 'PRIOR_MONTH'),
    dimension: oneOf<FluxDimension>(row.dimension, FLUX_DIMENSIONS, 'ACCOUNT'),
    includePnl: row.include_pnl !== false,
    includeBalanceSheet: row.include_balance_sheet !== false,
    overrides,
    excludedAccountIds: Array.isArray(row.excluded_account_ids) ? row.excluded_account_ids : [],
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

/** Pick the company row over the tenant row over the built-in default. */
export function pickPolicy(rows: FluxPolicyRow[], locationId: string): FluxPolicy {
  const company = rows.find((r) => r.location_id === locationId) ?? null;
  if (company) return policyFromRow(company, 'COMPANY');
  const tenant = rows.find((r) => r.location_id === null) ?? null;
  if (tenant) return policyFromRow(tenant, 'TENANT');
  return DEFAULT_FLUX_POLICY;
}

/**
 * The threshold for one account. Overrides apply TYPE → GROUP → ACCOUNT so the most
 * specific one wins for each field it sets; the source label names the most specific
 * override that applied. `excludedAccountIds` always excludes.
 */
export function resolveThreshold(policy: FluxPolicy, account: Pick<FluxAccount, 'id' | 'number' | 'type' | 'groupId' | 'groupName'>): ResolvedThreshold {
  const out: ResolvedThreshold = {
    mode: policy.thresholdMode,
    absThresholdCents: policy.absThresholdCents,
    pctThresholdBps: policy.pctThresholdBps,
    excluded: false,
    source: 'Policy',
  };
  const order: Array<[OverrideScope, string | null, string]> = [
    ['TYPE', account.type, `Override: ${account.type}`],
    ['GROUP', account.groupId, `Override: ${account.groupName ?? 'account group'}`],
    ['ACCOUNT', account.id, `Override: account ${account.number}`],
  ];
  for (const [scope, key, label] of order) {
    if (!key) continue;
    const o = policy.overrides.find((x) => x.scope === scope && x.key === key);
    if (!o) continue;
    if (o.absThresholdCents != null) out.absThresholdCents = o.absThresholdCents;
    if (o.pctThresholdBps != null) out.pctThresholdBps = o.pctThresholdBps;
    if (o.mode) out.mode = o.mode;
    if (o.excluded != null) out.excluded = o.excluded;
    out.source = label;
  }
  if (policy.excludedAccountIds.includes(account.id)) {
    out.excluded = true;
    out.source = 'Excluded account';
  }
  return out;
}

/** change / |comparison| in basis points (rounded); null when the comparison is 0. */
export function pctChangeBps(changeCents: number, comparisonCents: number): number | null {
  if (comparisonCents === 0) return null;
  return Math.round((changeCents / Math.abs(comparisonCents)) * 10_000);
}

export interface MaterialityResult {
  material: boolean;
  breaches: BreachReason[];
}

/** Is a change material under a resolved threshold? A zero change is never material. */
export function evaluateMateriality(changeCents: number, changePctBps: number | null, t: ResolvedThreshold): MaterialityResult {
  if (t.excluded || changeCents === 0) return { material: false, breaches: [] };
  const abs = Math.abs(changeCents) >= t.absThresholdCents;
  const pct = changePctBps !== null && Math.abs(changePctBps) >= t.pctThresholdBps;
  const breaches: BreachReason[] = [];
  if (abs) breaches.push('ABS');
  if (pct) breaches.push('PCT');
  let material: boolean;
  switch (t.mode) {
    case 'EITHER':
      material = abs || pct;
      break;
    case 'BOTH':
      // Zero base: the % is undefined, so the $ test decides alone.
      material = changePctBps === null ? abs : abs && pct;
      break;
    case 'ABS_ONLY':
      material = abs;
      break;
    case 'PCT_ONLY':
      material = pct;
      break;
    default:
      material = false;
  }
  return { material, breaches: material ? breaches : [] };
}

/** "$5,000 or 10%" — the plain-language threshold. */
export function describeThreshold(t: ResolvedThreshold, money: (cents: number) => string): string {
  if (t.excluded) return 'Excluded';
  const d = money(t.absThresholdCents);
  const p = `${(t.pctThresholdBps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
  switch (t.mode) {
    case 'EITHER': return `${d} or ${p}`;
    case 'BOTH': return `${d} and ${p}`;
    case 'ABS_ONLY': return d;
    case 'PCT_ONLY': return p;
    default: return '';
  }
}
