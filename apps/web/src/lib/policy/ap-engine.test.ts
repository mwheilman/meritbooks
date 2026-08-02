import { describe, it, expect } from 'vitest';
import { evaluateBill, resolveVendorRule, resolveCategoryRule, type ApBillSubject } from './ap-engine';
import { apPolicyRulesetSchema, DEFAULT_AP_RULESET, type ApPolicyRuleset } from './ap-schema';

/** Build a validated ruleset from a partial (fills defaults via the schema). */
function ruleset(partial: Record<string, unknown> = {}): ApPolicyRuleset {
  return apPolicyRulesetSchema.parse(partial);
}

const VID = '00000000-0000-0000-0000-000000000001';

const bill = (over: Partial<ApBillSubject> = {}): ApBillSubject => ({
  billId: 'b1',
  vendorId: VID,
  vendorName: 'Acme Supply Co',
  totalCents: 100_00,
  lines: [{ accountId: null, accountNumber: null, categoryLabel: 'General', amountCents: 100_00 }],
  hasPurchaseOrder: false,
  threeWayMatchStatus: 'NONE',
  isSuspectedDuplicate: false,
  ...over,
});

const ruleIds = (violations: { rule_id: string }[]) => violations.map((v) => v.rule_id).sort();

describe('ap-engine — no active policy (DEFAULT_AP_RULESET)', () => {
  it('yields zero violations, a null tier, and is NOT blocked — conservative default', () => {
    const ev = evaluateBill(bill({ totalCents: 9_999_999_00 }), DEFAULT_AP_RULESET);
    expect(ev.violations).toHaveLength(0);
    expect(ev.requiredApprovalTier).toBeNull();
    expect(ev.blocked).toBe(false);
  });
});

describe('ap-engine — vendor matching', () => {
  it('matches by exact core vendor id (strongest signal)', () => {
    const rs = ruleset({ vendors: [{ matchVendorId: VID, matchKeywords: [], prohibited: true }] });
    const r = resolveVendorRule({ vendorId: VID, vendorName: null }, rs);
    expect(r?.prohibited).toBe(true);
  });
  it('matches by keyword against the vendor name', () => {
    const rs = ruleset({ vendors: [{ matchVendorId: null, matchKeywords: ['acme'], prohibited: true }] });
    const r = resolveVendorRule({ vendorId: null, vendorName: 'ACME Supply Co' }, rs);
    expect(r?.prohibited).toBe(true);
  });
  it('returns null when nothing matches', () => {
    const rs = ruleset({ vendors: [{ matchVendorId: '00000000-0000-0000-0000-0000000000ff', matchKeywords: ['zzz'] }] });
    expect(resolveVendorRule({ vendorId: VID, vendorName: 'Acme' }, rs)).toBeNull();
  });
});

describe('ap-engine — prohibited vendor', () => {
  it('BLOCKs a prohibited vendor', () => {
    const rs = ruleset({ vendors: [{ matchVendorId: VID, prohibited: true, severity: 'BLOCK' }] });
    const ev = evaluateBill(bill(), rs);
    expect(ruleIds(ev.violations)).toContain('VENDOR_PROHIBITED');
    expect(ev.blocked).toBe(true);
  });
});

describe('ap-engine — per-vendor bill limit', () => {
  const rs = ruleset({ vendors: [{ matchVendorId: VID, perBillLimitCents: 500_00, severity: 'BLOCK' }] });
  it('flags over the vendor cap', () => {
    const ev = evaluateBill(bill({ totalCents: 600_00 }), rs);
    expect(ruleIds(ev.violations)).toContain('VENDOR_BILL_LIMIT');
    expect(ev.violations[0].limitCents).toBe(500_00);
  });
  it('does NOT flag exactly at the cap', () => {
    expect(ruleIds(evaluateBill(bill({ totalCents: 500_00 }), rs).violations)).not.toContain('VENDOR_BILL_LIMIT');
  });
});

describe('ap-engine — category / GL matching + limits', () => {
  const rs = ruleset({
    categories: [
      { category: 'SUBCONTRACTOR', matchKeywords: ['framing'], matchAccountNumbers: ['5010'], perLineLimitCents: 200_00, perBillLimitCents: 300_00, severity: 'BLOCK' },
    ],
  });
  it('matches by GL account number', () => {
    const c = resolveCategoryRule({ accountId: null, accountNumber: '5010', categoryLabel: null }, rs);
    expect(c?.category).toBe('SUBCONTRACTOR');
  });
  it('matches by keyword against the line label', () => {
    const c = resolveCategoryRule({ accountId: null, accountNumber: null, categoryLabel: 'Framing labor' }, rs);
    expect(c?.category).toBe('SUBCONTRACTOR');
  });
  it('flags a per-line limit breach', () => {
    const ev = evaluateBill(bill({ totalCents: 250_00, lines: [{ accountId: null, accountNumber: '5010', categoryLabel: 'x', amountCents: 250_00 }] }), rs);
    expect(ruleIds(ev.violations)).toContain('CATEGORY_LINE_LIMIT');
  });
  it('flags a per-bill category total breach across lines', () => {
    const ev = evaluateBill(bill({
      totalCents: 320_00,
      lines: [
        { accountId: null, accountNumber: '5010', categoryLabel: 'a', amountCents: 160_00 },
        { accountId: null, accountNumber: '5010', categoryLabel: 'b', amountCents: 160_00 },
      ],
    }), rs);
    expect(ruleIds(ev.violations)).toContain('CATEGORY_BILL_LIMIT');
  });
  it('BLOCKs a prohibited category', () => {
    const prohibited = ruleset({ categories: [{ category: 'ALCOHOL', matchKeywords: ['bar'], prohibited: true }] });
    const ev = evaluateBill(bill({ lines: [{ accountId: null, accountNumber: null, categoryLabel: 'Corner Bar tab', amountCents: 100_00 }] }), prohibited);
    expect(ruleIds(ev.violations)).toContain('CATEGORY_PROHIBITED');
    expect(ev.blocked).toBe(true);
  });
});

describe('ap-engine — absolute per-bill ceiling', () => {
  it('flags over the ceiling with its severity', () => {
    const rs = ruleset({ perBillCeilingCents: 5_000_00, perBillCeilingSeverity: 'BLOCK' });
    const ev = evaluateBill(bill({ totalCents: 6_000_00 }), rs);
    expect(ruleIds(ev.violations)).toContain('PER_BILL_CEILING');
    expect(ev.blocked).toBe(true);
  });
});

describe('ap-engine — require PO over threshold', () => {
  const rs = ruleset({ requirePoOverCents: 10_000_00, requirePoSeverity: 'BLOCK' });
  it('requires a PO at/above the threshold when none is linked', () => {
    const ev = evaluateBill(bill({ totalCents: 10_000_00, hasPurchaseOrder: false }), rs);
    expect(ruleIds(ev.violations)).toContain('PO_REQUIRED');
  });
  it('is satisfied when a PO is linked', () => {
    const ev = evaluateBill(bill({ totalCents: 20_000_00, hasPurchaseOrder: true }), rs);
    expect(ruleIds(ev.violations)).not.toContain('PO_REQUIRED');
  });
  it('does not fire below the threshold', () => {
    const ev = evaluateBill(bill({ totalCents: 9_999_00, hasPurchaseOrder: false }), rs);
    expect(ruleIds(ev.violations)).not.toContain('PO_REQUIRED');
  });
});

describe('ap-engine — require 3-way match over threshold', () => {
  const rs = ruleset({ requireThreeWayMatchOverCents: 25_000_00, threeWayMatchSeverity: 'BLOCK' });
  it('fails for NONE / PENDING / EXCEPTION at/above the threshold', () => {
    for (const s of ['NONE', 'PENDING', 'EXCEPTION'] as const) {
      const ev = evaluateBill(bill({ totalCents: 30_000_00, hasPurchaseOrder: true, threeWayMatchStatus: s }), rs);
      expect(ruleIds(ev.violations)).toContain('THREE_WAY_MATCH_REQUIRED');
    }
  });
  it('passes for MATCHED and (human-cleared) OVERRIDDEN', () => {
    for (const s of ['MATCHED', 'OVERRIDDEN'] as const) {
      const ev = evaluateBill(bill({ totalCents: 30_000_00, hasPurchaseOrder: true, threeWayMatchStatus: s }), rs);
      expect(ruleIds(ev.violations)).not.toContain('THREE_WAY_MATCH_REQUIRED');
    }
  });
});

describe('ap-engine — duplicate bill block', () => {
  it('blocks a suspected duplicate only when the toggle is on', () => {
    const on = ruleset({ duplicateBillBlock: true, duplicateBillSeverity: 'BLOCK' });
    const off = ruleset({ duplicateBillBlock: false });
    expect(ruleIds(evaluateBill(bill({ isSuspectedDuplicate: true }), on).violations)).toContain('DUPLICATE_BILL');
    expect(ruleIds(evaluateBill(bill({ isSuspectedDuplicate: true }), off).violations)).not.toContain('DUPLICATE_BILL');
  });
});

describe('ap-engine — approval tier + block semantics', () => {
  const rs = ruleset({
    approvalTiers: [
      { uptoCents: 5_000_00, tier: 'MANAGER' },
      { uptoCents: 50_000_00, tier: 'CONTROLLER' },
      { uptoCents: null, tier: 'CFO' },
    ],
    perBillCeilingCents: 100_000_00,
    perBillCeilingSeverity: 'WARN',
  });
  it('routes by the bill total (inclusive bounds, catch-all last)', () => {
    expect(evaluateBill(bill({ totalCents: 4_000_00 }), rs).requiredApprovalTier).toBe('MANAGER');
    expect(evaluateBill(bill({ totalCents: 5_000_00 }), rs).requiredApprovalTier).toBe('MANAGER');
    expect(evaluateBill(bill({ totalCents: 40_000_00 }), rs).requiredApprovalTier).toBe('CONTROLLER');
    expect(evaluateBill(bill({ totalCents: 900_000_00 }), rs).requiredApprovalTier).toBe('CFO');
  });
  it('a WARN-only violation surfaces but does NOT block (override not required)', () => {
    const ev = evaluateBill(bill({ totalCents: 200_000_00 }), rs);
    expect(ruleIds(ev.violations)).toContain('PER_BILL_CEILING');
    expect(ev.blocked).toBe(false); // WARN severity → not blocked
  });
});
