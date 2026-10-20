/**
 * Dealer Pack D2 slice C — pure helpers for warranty / incentives / OEM statements
 * (lib/dealer/ui/claims.ts) and the settings form model (lib/dealer/ui/settings-form.ts).
 */

import { describe, expect, it } from 'vitest';
import { computeClaim } from '../engine/warranty';
import { defaultSettings } from '../types';
import {
  addDaysIso,
  footing,
  incentiveActions,
  incentiveAging,
  incentiveOpenCents,
  incentiveWriteOffEffect,
  proposalFromLine,
  rejectionRates,
  settlementEffect,
  warrantyActions,
  warrantyAging,
  warrantyOpenCents,
  warrantyResolveEffect,
  warrantySubmitEffect,
} from './claims';
import {
  DEFAULTS,
  THRESHOLD_FIELDS,
  bucketLabels,
  editable,
  formatStored,
  fromDisplay,
  settingsDiff,
  toDisplay,
  validateBuckets,
} from './settings-form';

const S = defaultSettings('org', 'loc');
const TODAY = '2026-10-20';

describe('claims: open amounts', () => {
  it('warranty open = claimed − settled − written off (FPB §3.8 short-pay)', () => {
    expect(warrantyOpenCents({ claimed_cents: 29_400, settled_cents: 27_000, written_off_cents: 0 })).toBe(2_400);
  });
  it('incentive open = accrued − settled − written off (matches the settle service)', () => {
    expect(incentiveOpenCents({ accrued_cents: 20_000, settled_cents: 5_000, written_off_cents: 1_000 })).toBe(14_000);
  });
  it('the live preview equals the FPB §3.8 claim (2.0h × $95 + $80 × 1.30 = $294)', () => {
    const c = computeClaim({ laborHours: '2.0', laborRateCents: 9_500, partsCostCents: 8_000, partsMarkupBps: 3_000, subletCents: 0, freightCents: 0, otherCents: 0 });
    expect([c.laborCents, c.partsCents, c.claimedCents]).toEqual([19_000, 10_400, 29_400]);
  });
});

describe('claims: aging (DL-5 / DL-7)', () => {
  it('draft within the warning window of its filing deadline is red', () => {
    const r = warrantyAging({ status: 'DRAFT', filing_deadline: '2026-10-23', submitted_date: null }, S, TODAY);
    expect(r.flag).toEqual({ tone: 'danger', label: 'File within 3 days' });
  });
  it('draft past its deadline is red; one far away is not flagged', () => {
    expect(warrantyAging({ status: 'DRAFT', filing_deadline: '2026-10-18', submitted_date: null }, S, TODAY).flag?.label).toBe('Filing deadline passed 2 days ago');
    expect(warrantyAging({ status: 'DRAFT', filing_deadline: '2026-12-01', submitted_date: null }, S, TODAY).flag).toBeNull();
  });
  it('submitted unpaid past the setting is amber, with days outstanding', () => {
    const r = warrantyAging({ status: 'PARTIAL', filing_deadline: null, submitted_date: '2026-09-01' }, S, TODAY);
    expect(r.daysOutstanding).toBe(49);
    expect(r.flag?.tone).toBe('warning');
    expect(warrantyAging({ status: 'SUBMITTED', filing_deadline: null, submitted_date: '2026-10-01' }, S, TODAY).flag).toBeNull();
  });
  it('paid claims are never flagged', () => {
    expect(warrantyAging({ status: 'PAID', filing_deadline: '2026-01-01', submitted_date: '2026-01-01' }, S, TODAY).flag).toBeNull();
  });
  it('incentive: amber within the warning window, red in the last days / past', () => {
    expect(incentiveAging({ status: 'ACCRUED', claim_deadline: '2026-10-28', submitted_date: null }, S, TODAY).flag?.tone).toBe('warning');
    expect(incentiveAging({ status: 'ACCRUED', claim_deadline: '2026-10-22', submitted_date: null }, S, TODAY).flag?.tone).toBe('danger');
    expect(incentiveAging({ status: 'ACCRUED', claim_deadline: '2026-10-10', submitted_date: null }, S, TODAY).flag?.tone).toBe('danger');
    expect(incentiveAging({ status: 'SUBMITTED', claim_deadline: null, submitted_date: '2026-08-01' }, S, TODAY).flag?.tone).toBe('warning');
  });
  it('addDaysIso is TZ-safe across month ends', () => {
    expect(addDaysIso('2026-10-20', -91)).toBe('2026-07-21');
    expect(addDaysIso('2026-02-28', 1)).toBe('2026-03-01');
  });
});

describe('claims: actions follow the service guards', () => {
  const base = { ro_closed_date: null, claimed_cents: 29_400, settled_cents: 0, written_off_cents: 0 };
  it('draft: edit, close RO, submit', () => {
    expect(warrantyActions({ ...base, status: 'DRAFT' })).toEqual(['EDIT', 'RO_CLOSE', 'SUBMIT']);
    expect(warrantyActions({ ...base, status: 'DRAFT', ro_closed_date: '2026-10-01' })).toEqual(['EDIT', 'SUBMIT']);
  });
  it('partly paid with a credit: accept short-pay (not write off), resubmit, debit', () => {
    const a = warrantyActions({ ...base, status: 'PARTIAL', settled_cents: 27_000 });
    expect(a).toContain('ACCEPT_SHORT_PAY');
    expect(a).not.toContain('WRITE_OFF');
    expect(a).toEqual(expect.arrayContaining(['SETTLE', 'RESUBMIT', 'DEBIT']));
  });
  it('paid: only a later charge-back', () => {
    expect(warrantyActions({ ...base, status: 'PAID', settled_cents: 29_400 })).toEqual(['DEBIT']);
  });
  it('incentive write-off needs a known accrual target', () => {
    const row = { status: 'SUBMITTED' as const, accrued_cents: 10_000, settled_cents: 0, written_off_cents: 0, accrual_target_role: null };
    expect(incentiveActions(row)).not.toContain('WRITE_OFF');
    expect(incentiveActions({ ...row, accrual_target_role: 'WHOLE_GOODS_COGS' })).toContain('WRITE_OFF');
    expect(incentiveActions({ ...row, status: 'REJECTED', accrual_target_role: 'WHOLE_GOODS_COGS' })).toEqual(['SUBMIT', 'WRITE_OFF']);
  });
});

describe('claims: plain-English GL sentences', () => {
  it('short-pay acceptance names the amount and the account', () => {
    expect(warrantyResolveEffect('ACCEPT_SHORT_PAY', { openCents: 2_400 })).toBe('Books the $24.00 shortfall to warranty policy expense (Service) and closes the claim as paid.');
  });
  it('a short statement credit says what stays open', () => {
    const s = settlementEffect({ receivable: 'warranty', amountCents: 27_000, openCents: 29_400, method: 'STATEMENT_CREDIT', manufacturer: 'the OEM' });
    expect(s).toContain('accounts payable');
    expect(s).toContain('$24.00 stays open');
  });
  it('submission books labor and parts sales and relieves parts at cost', () => {
    const s = warrantySubmitEffect({
      claim: { labor_cents: 19_000, parts_cents: 10_400, sublet_cents: 0, freight_cents: 0, other_cents: 0, claimed_cents: 29_400, parts_cost_cents: 8_000, recognized_gl_entry_id: null },
      relieveParts: true,
    });
    expect(s).toContain('$294.00 receivable');
    expect(s).toContain('$190.00 warranty labor sales');
    expect(s).toContain('$80.00 of parts');
  });
  it('an in-stock rebate write-off restores unit cost', () => {
    expect(incentiveWriteOffEffect({ targetRole: 'WHOLE_GOODS_INVENTORY', openCents: 20_000, unitInStock: true })).toContain('unit’s cost goes back up by $200.00');
    expect(incentiveWriteOffEffect({ targetRole: 'WHOLE_GOODS_COGS', openCents: 20_000, unitInStock: false })).toContain('whole goods cost of sales');
  });
});

describe('OEM statements', () => {
  it('footing: signed lines must sum to the footer', () => {
    expect(footing([{ amountCents: 27_000 }, { amountCents: -5_000 }], 22_000).foots).toBe(true);
    const off = footing([{ amountCents: 27_000 }], 27_100);
    expect(off.foots).toBe(false);
    expect(off.differenceCents).toBe(100);
    expect(footing([{ amountCents: null }], 0).foots).toBe(false);
  });
  it('a persisted suggestion recovers its method and short-pay', () => {
    const p = proposalFromLine(
      { id: 'l1', match_status: 'PROPOSED', matched_warranty_claim_id: 'w1', matched_incentive_claim_id: null, match_confidence_bps: 9_000, amount_cents: 27_000 },
      29_400,
    );
    expect(p).toMatchObject({ claimKind: 'WARRANTY', claimId: 'w1', method: 'CLAIM_NUMBER_SHORT', shortPayCents: 2_400, autoSettleEligible: false });
    expect(proposalFromLine({ id: 'l2', match_status: 'SETTLED', matched_warranty_claim_id: 'w1', matched_incentive_claim_id: null, match_confidence_bps: 10_000, amount_cents: 1 }, 1)).toBeNull();
  });
  it('DL-6 rejection rate: distinct claims rejected ÷ submitted, flagged above 10%', () => {
    const ev = [
      ...Array.from({ length: 8 }, (_, i) => ({ claimId: `c${i}`, oemVendorId: 'A', type: 'SUBMITTED' })),
      { claimId: 'c1', oemVendorId: 'A', type: 'REJECTED' },
      { claimId: 'x', oemVendorId: 'B', type: 'SUBMITTED' },
    ];
    const r = rejectionRates(ev);
    expect(r[0]).toMatchObject({ oemVendorId: 'A', submitted: 8, rejected: 1, rateBps: 1250, flagged: true });
    expect(r[1]).toMatchObject({ oemVendorId: 'B', rejected: 0, flagged: false });
  });
});

describe('settings form', () => {
  const field = (k: string) => THRESHOLD_FIELDS.find((f) => f.key === k)!;
  it('covers every numeric threshold in settingsPatch exactly once', () => {
    expect(new Set(THRESHOLD_FIELDS.map((f) => f.key)).size).toBe(THRESHOLD_FIELDS.length);
    expect(THRESHOLD_FIELDS).toHaveLength(15);
  });
  it('dollars ↔ cents and percent ↔ bps without float drift', () => {
    expect(fromDisplay(field('interest_tolerance_cents'), '25.10')).toEqual({ ok: true, value: 2_510 });
    expect(fromDisplay(field('interest_tolerance_bps'), '2.5')).toEqual({ ok: true, value: 250 });
    expect(fromDisplay(field('auto_match_min_confidence_bps'), '95%')).toEqual({ ok: true, value: 9_500 });
    expect(toDisplay('percent', 9_500)).toBe('95');
    expect(toDisplay('percent', 250)).toBe('2.5');
    expect(toDisplay('percent', 905)).toBe('9.05');
    expect(toDisplay('dollars', 2_500)).toBe('25.00');
  });
  it('enforces the settingsPatch bounds', () => {
    expect(fromDisplay(field('sot_grace_days'), '31')).toMatchObject({ ok: false });
    expect(fromDisplay(field('auto_match_min_confidence_bps'), '101')).toMatchObject({ ok: false });
    expect(fromDisplay(field('warranty_deadline_warn_days'), '2.5')).toMatchObject({ ok: false, error: 'Enter whole days' });
    expect(fromDisplay(field('trade_acv_approval_threshold_cents'), '0')).toEqual({ ok: true, value: 0 });
  });
  it('defaults render in human units', () => {
    expect(formatStored('dollars', DEFAULTS.interest_tolerance_cents)).toBe('$25.00');
    expect(formatStored('percent', DEFAULTS.interest_tolerance_bps)).toBe('2%');
    expect(formatStored('days', DEFAULTS.sot_grace_days)).toBe('2 days');
  });
  it('aging buckets: ascending, distinct, 1–8 edges', () => {
    expect(validateBuckets([90, 180, 270, 365])).toBeNull();
    expect(validateBuckets([180, 90])).not.toBeNull();
    expect(validateBuckets([])).not.toBeNull();
    expect(bucketLabels([90, 180])).toEqual(['0–90 days', '91–180 days', 'over 180 days']);
  });
  it('diff sends only changed fields (blank DMS → null)', () => {
    const d = editable(S);
    expect(settingsDiff(S, d)).toEqual({});
    d.sot_grace_days = 3;
    d.aging_buckets = [60, 120];
    d.dms_system = '  ';
    expect(settingsDiff(S, d)).toEqual({ sot_grace_days: 3, aging_buckets: [60, 120] });
  });
});
