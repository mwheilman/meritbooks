/** AC-3E.1 — materiality: modes, zero base, override precedence, exclusions. */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FLUX_POLICY,
  describeThreshold,
  evaluateMateriality,
  parseOverride,
  pctChangeBps,
  pickPolicy,
  policyFromRow,
  resolveThreshold,
  type FluxPolicyRow,
} from './materiality';
import type { FluxPolicy, ResolvedThreshold } from './types';

const T = (over: Partial<ResolvedThreshold> = {}): ResolvedThreshold => ({
  mode: 'EITHER', absThresholdCents: 500_000, pctThresholdBps: 1_000, excluded: false, source: 'Policy', ...over,
});

const ACCT = { id: 'a-6100', number: '6100', type: 'OPEX' as const, groupId: 'g-occ', groupName: 'Occupancy' };

describe('pctChangeBps', () => {
  it('is change over |comparison| in bps, null on a zero base', () => {
    expect(pctChangeBps(1_000_00, 10_000_00)).toBe(1_000);
    expect(pctChangeBps(-1_000_00, -10_000_00)).toBe(-1_000); // credit-ish base: sign follows the change
    expect(pctChangeBps(5_00, 0)).toBeNull();
    expect(pctChangeBps(1, 3)).toBe(3_333);
  });
});

describe('evaluateMateriality', () => {
  it('EITHER breaches on $ or %', () => {
    expect(evaluateMateriality(600_000, 500, T())).toEqual({ material: true, breaches: ['ABS'] });
    expect(evaluateMateriality(100_000, 2_000, T())).toEqual({ material: true, breaches: ['PCT'] });
    expect(evaluateMateriality(100_000, 500, T())).toEqual({ material: false, breaches: [] });
  });

  it('BOTH needs $ and %', () => {
    expect(evaluateMateriality(600_000, 500, T({ mode: 'BOTH' })).material).toBe(false);
    expect(evaluateMateriality(100_000, 2_000, T({ mode: 'BOTH' })).material).toBe(false);
    expect(evaluateMateriality(600_000, 2_000, T({ mode: 'BOTH' }))).toEqual({ material: true, breaches: ['ABS', 'PCT'] });
  });

  it('ABS_ONLY / PCT_ONLY test one side', () => {
    expect(evaluateMateriality(600_000, 0, T({ mode: 'ABS_ONLY' })).material).toBe(true);
    expect(evaluateMateriality(100_000, 9_000, T({ mode: 'ABS_ONLY' })).material).toBe(false);
    expect(evaluateMateriality(100, 1_000, T({ mode: 'PCT_ONLY' })).material).toBe(true);
    expect(evaluateMateriality(9_000_000, 999, T({ mode: 'PCT_ONLY' })).material).toBe(false);
  });

  it('zero base: % cannot breach; EITHER/BOTH fall to the $ test; PCT_ONLY cannot breach', () => {
    expect(evaluateMateriality(600_000, null, T()).material).toBe(true);
    expect(evaluateMateriality(600_000, null, T({ mode: 'BOTH' })).material).toBe(true);
    expect(evaluateMateriality(100_000, null, T({ mode: 'BOTH' })).material).toBe(false);
    expect(evaluateMateriality(9_000_000, null, T({ mode: 'PCT_ONLY' })).material).toBe(false);
  });

  it('a zero change or an excluded line is never material', () => {
    expect(evaluateMateriality(0, 0, T({ absThresholdCents: 0, pctThresholdBps: 0 })).material).toBe(false);
    expect(evaluateMateriality(9_000_000, 9_000, T({ excluded: true })).material).toBe(false);
  });

  it('the $ threshold is inclusive and works on decreases', () => {
    expect(evaluateMateriality(-500_000, -100, T()).material).toBe(true);
    expect(evaluateMateriality(-499_999, -100, T()).material).toBe(false);
  });
});

describe('resolveThreshold — overrides', () => {
  const policy: FluxPolicy = {
    ...DEFAULT_FLUX_POLICY,
    overrides: [
      { scope: 'TYPE', key: 'OPEX', absThresholdCents: 250_000, pctThresholdBps: null, mode: null, excluded: null },
      { scope: 'GROUP', key: 'g-occ', absThresholdCents: null, pctThresholdBps: 2_500, mode: 'BOTH', excluded: null },
      { scope: 'ACCOUNT', key: 'a-6100', absThresholdCents: 100_000, pctThresholdBps: null, mode: null, excluded: null },
    ],
  };

  it('applies TYPE → GROUP → ACCOUNT, most specific wins field by field', () => {
    const t = resolveThreshold(policy, ACCT);
    expect(t).toMatchObject({ absThresholdCents: 100_000, pctThresholdBps: 2_500, mode: 'BOTH', excluded: false, source: 'Override: account 6100' });
  });

  it('falls back to the type override for another account in the type', () => {
    const t = resolveThreshold(policy, { ...ACCT, id: 'a-6200', number: '6200', groupId: 'g-other', groupName: 'Other' });
    expect(t).toMatchObject({ absThresholdCents: 250_000, pctThresholdBps: 1_000, mode: 'EITHER', source: 'Override: OPEX' });
  });

  it('uses the policy for an unrelated type', () => {
    expect(resolveThreshold(policy, { ...ACCT, id: 'r', number: '4000', type: 'REVENUE', groupId: null, groupName: null }).source).toBe('Policy');
  });

  it('an override may exclude, and excluded_account_ids always excludes', () => {
    const p1: FluxPolicy = { ...DEFAULT_FLUX_POLICY, overrides: [{ scope: 'GROUP', key: 'g-occ', excluded: true }] };
    expect(resolveThreshold(p1, ACCT).excluded).toBe(true);
    const p2: FluxPolicy = { ...policy, excludedAccountIds: ['a-6100'] };
    expect(resolveThreshold(p2, ACCT)).toMatchObject({ excluded: true, source: 'Excluded account' });
  });
});

describe('policy rows', () => {
  const row = (over: Partial<FluxPolicyRow>): FluxPolicyRow => ({
    id: 'p', location_id: null, review_required: true, threshold_mode: 'BOTH', abs_threshold_cents: '250000', pct_threshold_bps: 500,
    comparison_basis: 'TRAILING_3_AVG', dimension: 'ACCOUNT', include_pnl: true, include_balance_sheet: false,
    overrides: [{ scope: 'TYPE', key: 'OPEX', absThresholdCents: 1 }, { scope: 'NOPE', key: 'x' }, { scope: 'ACCOUNT', key: 'a', mode: 'WILD' }],
    excluded_account_ids: ['x'], updated_at: null, updated_by: null, ...over,
  });

  it('parses a row and drops invalid overrides', () => {
    const p = policyFromRow(row({}), 'TENANT');
    expect(p).toMatchObject({ thresholdMode: 'BOTH', absThresholdCents: 250_000, pctThresholdBps: 500, comparisonBasis: 'TRAILING_3_AVG', includeBalanceSheet: false, source: 'TENANT' });
    expect(p.overrides).toHaveLength(1);
    expect(parseOverride({ scope: 'TYPE', key: 'OPEX', absThresholdCents: -5 })).toBeNull();
  });

  it('company row beats tenant row beats the built-in default', () => {
    const tenant = row({ id: 't' });
    const company = row({ id: 'c', location_id: 'loc-1', threshold_mode: 'ABS_ONLY' });
    expect(pickPolicy([tenant, company], 'loc-1')).toMatchObject({ id: 'c', source: 'COMPANY', thresholdMode: 'ABS_ONLY' });
    expect(pickPolicy([tenant, company], 'loc-2')).toMatchObject({ id: 't', source: 'TENANT' });
    expect(pickPolicy([], 'loc-2')).toBe(DEFAULT_FLUX_POLICY);
    expect(DEFAULT_FLUX_POLICY).toMatchObject({ thresholdMode: 'EITHER', absThresholdCents: 500_000, pctThresholdBps: 1_000, comparisonBasis: 'PRIOR_MONTH', reviewRequired: true });
  });

  it('describes a threshold in plain words', () => {
    const money = (c: number) => `$${(c / 100).toLocaleString('en-US')}`;
    expect(describeThreshold(T(), money)).toBe('$5,000 or 10%');
    expect(describeThreshold(T({ mode: 'BOTH', pctThresholdBps: 250 }), money)).toBe('$5,000 and 2.5%');
    expect(describeThreshold(T({ excluded: true }), money)).toBe('Excluded');
  });
});
