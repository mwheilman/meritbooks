/**
 * Separation of duties (05 §4.1 H6, §4.3) + dollar limits (§3.4) — pure decision tests.
 * DB twin (core.sod_conflicts_for_membership, triggers, release guard) is proven in
 * src/test/sod-approvals.test.ts.
 */

import { describe, it, expect } from 'vitest';
import type { AccessSnapshot, AssignmentInput, ResolvedGrant } from './effective-access';
import type { Action } from './capabilities';
import {
  ACTION_SOD_MESSAGE,
  ACTION_SOD_RULE_KEY,
  approverReleasePolicyOf,
  assertActionSod,
  checkActionSod,
  isApproverReleaseLoosening,
  checkAssignmentSod,
  conflictMessage,
  detectConflicts,
  effectiveEnforcement,
  matchRules,
  SodViolationError,
  type SodException,
  type SodPolicy,
  type SodRule,
} from './sod';
import { approvalLimitCheck, meetsApproverFloor, withinApprovalLimit } from './limits';

const ORG = 'org-1';
const L1 = 'loc-1';
const L2 = 'loc-2';
const COMPANY: SodPolicy = { tenantType: 'company', promotedRuleIds: new Set() };
const FIRM: SodPolicy = { tenantType: 'firm', promotedRuleIds: new Set() };

function rule(key: string, legs: string[][], extra: Partial<SodRule> = {}): SodRule {
  return {
    id: `rule-${key}`,
    orgId: null,
    key,
    ruleType: 'role',
    name: key,
    description: `Could do ${key}.`,
    suggestedFix: 'Split it.',
    legs,
    enforcement: 'soft',
    tenantTypeOverride: {},
    platformLocked: false,
    status: 'active',
    sortOrder: 10,
    ...extra,
  };
}

const S2 = rule('S2', [['pay.vendor_bank_details:edit'], ['pay.batches:release']], {
  tenantTypeOverride: { firm: 'hard' },
  description: "Could change a vendor's bank details and then release payments to that account.",
});
const S3 = rule('S3', [['ar.credit_memos:approve', 'ar.write_offs:approve'], ['pay.customer_payments:create']]);
const S6 = rule('S6', [['core.access.assignments:create'], ['*:release']]);
const S7 = rule('S7', [['mdm.vendors:create'], ['ap.bills:approve'], ['pay.batches:release']], {
  description: 'Could both create vendors and release payments to them, approving the bills in between.',
});
const S9 = rule('S9', [['bank.reconciliations:edit'], ['bank.reconciliations:approve']], { enforcement: 'txn_only' });
const RULES = [S2, S3, S6, S7, S9];

let seq = 0;
function assignment(grants: Array<[string, Action[], ResolvedGrant['constraints']?]>, scope: Partial<AssignmentInput> = {}): AssignmentInput {
  seq += 1;
  return {
    id: `a-${seq}`,
    grantType: 'role',
    source: { id: `r-${seq}`, key: `role${seq}`, name: `Role ${seq}`, ownerLevel: 'tenant', locationId: null, audience: 'internal_staff', version: 1 },
    grants: grants.map(([capability, actions, constraints]) => ({ capability, actions, constraints: constraints ?? {} })),
    scopeType: 'client',
    locationId: L1,
    clientSetId: null,
    clientSetLocationIds: [],
    groupId: null,
    readOnly: false,
    muted: {},
    constraintOverrides: {},
    effectiveFrom: null,
    effectiveTo: null,
    status: 'active',
    ...scope,
  };
}

function snapshot(assignments: AssignmentInput[]): AccessSnapshot {
  return {
    membership: { id: 'm-1', orgId: ORG, status: 'active', audience: 'internal_staff', accessEpoch: 0 },
    assignments,
    envelopes: {},
  };
}

const VENDOR_MAKER: Array<[string, Action[]]> = [['mdm.vendors', ['view', 'create']]];
const PAYER: Array<[string, Action[]]> = [['ap.bills', ['view', 'approve']], ['pay.batches', ['view', 'release']]];

describe('matchRules', () => {
  it('fires only when every leg is held; alternatives and wildcards satisfy a leg', () => {
    expect(matchRules(RULES, new Set(['mdm.vendors:create', 'ap.bills:approve'])).map((m) => m.rule.key)).toEqual([]);
    const all = new Set(['mdm.vendors:create', 'ap.bills:approve', 'pay.batches:release']);
    expect(matchRules(RULES, all).map((m) => m.rule.key)).toEqual(['S7']);
    // S3: either credit memos OR write-offs + customer payments
    const s3 = matchRules(RULES, new Set(['ar.write_offs:approve', 'pay.customer_payments:create']));
    expect(s3.map((m) => m.rule.key)).toEqual(['S3']);
    expect(s3[0].matched).toEqual(['ar.write_offs:approve', 'pay.customer_payments:create']);
    // S6 wildcard: any release
    const s6 = matchRules(RULES, new Set(['core.access.assignments:create', 'payroll.runs:release']));
    expect(s6.map((m) => m.rule.key)).toEqual(['S6']);
    expect(s6[0].matched).toEqual(['core.access.assignments:create', 'payroll.runs:release']);
  });

  it('ignores disabled and transaction rules', () => {
    const off = { ...S7, status: 'disabled' as const };
    const txn = { ...S7, id: 'x', ruleType: 'transaction' as const };
    expect(matchRules([off, txn], new Set(['mdm.vendors:create', 'ap.bills:approve', 'pay.batches:release']))).toEqual([]);
  });
});

describe('effectiveEnforcement — strictest wins, platform demotion impossible', () => {
  it('applies tenant-type override and tenant promotion; never relaxes hard / txn_only', () => {
    expect(effectiveEnforcement(S2, COMPANY)).toBe('soft');
    expect(effectiveEnforcement(S2, FIRM)).toBe('hard');
    expect(effectiveEnforcement(S7, { tenantType: 'company', promotedRuleIds: new Set([S7.id]) })).toBe('hard');
    expect(effectiveEnforcement(S9, { tenantType: 'company', promotedRuleIds: new Set([S9.id]) })).toBe('txn_only');
    expect(effectiveEnforcement({ ...S7, enforcement: 'hard' }, COMPANY)).toBe('hard');
  });
});

describe('detectConflicts — effective set per client', () => {
  const base = { rules: RULES, policy: COMPANY, exceptions: [] as SodException[], orgLocationIds: [L1, L2] };

  it('two harmless roles that together conflict are caught on the shared client only', () => {
    const snap = snapshot([assignment(VENDOR_MAKER), assignment(PAYER)]);
    const c = detectConflicts(snap, base);
    expect(c.map((x) => [x.ruleKey, x.locationId])).toEqual([['S7', L1]]);
    expect(c[0].description).toMatch(/create vendors and release payments/);
  });

  it('the same two roles on different clients are not a conflict', () => {
    const snap = snapshot([assignment(VENDOR_MAKER), assignment(PAYER, { locationId: L2 })]);
    expect(detectConflicts(snap, base)).toEqual([]);
  });

  it('an all-clients grant combines with a client grant on that client', () => {
    const snap = snapshot([assignment(VENDOR_MAKER, { scopeType: 'all_clients', locationId: null }), assignment(PAYER, { locationId: L2 })]);
    expect(detectConflicts(snap, base).map((x) => x.locationId)).toEqual([L2]);
  });

  it('mutes and read-only remove the conflicting action', () => {
    const muted = snapshot([assignment(VENDOR_MAKER), assignment(PAYER, { muted: { 'pay.batches': ['release'] } })]);
    expect(detectConflicts(muted, base)).toEqual([]);
    const ro = snapshot([assignment(VENDOR_MAKER, { readOnly: true }), assignment(PAYER)]);
    expect(detectConflicts(ro, base)).toEqual([]);
  });

  it('expired assignments do not count', () => {
    const snap = snapshot([assignment(VENDOR_MAKER), assignment(PAYER, { effectiveTo: '2000-01-01T00:00:00Z' })]);
    expect(detectConflicts(snap, base)).toEqual([]);
  });
});

describe('checkAssignmentSod — the assignment-time gate', () => {
  const opts = (exceptions: SodException[] = [], policy: SodPolicy = COMPANY) => ({
    rules: RULES,
    policy,
    exceptions,
    orgLocationIds: [L1, L2],
  });

  it('blocks a grant that creates a soft conflict until a reason is given', () => {
    const current = snapshot([assignment(VENDOR_MAKER)]);
    const r = checkAssignmentSod({ current, proposed: [assignment(PAYER)], ...opts() });
    expect(r.allowed).toBe(false);
    expect(r.needsJustification.map((c) => c.ruleKey)).toEqual(['S7']);
    expect(r.messages[0]).toBe(
      'Needs a reason: Could both create vendors and release payments to them, approving the bills in between. Split it.',
    );
    const withReason = checkAssignmentSod({ current, proposed: [assignment(PAYER)], justification: 'Owner-run company, CFO reviews weekly', ...opts() });
    expect(withReason.allowed).toBe(true);
    expect(withReason.toRecord.map((c) => c.ruleKey)).toEqual(['S7']);
  });

  it('a too-short reason does not count', () => {
    const current = snapshot([assignment(VENDOR_MAKER)]);
    expect(checkAssignmentSod({ current, proposed: [assignment(PAYER)], justification: 'ok', ...opts() }).allowed).toBe(false);
  });

  it('hard conflicts always block, even with a reason (firm tenant S2)', () => {
    const current = snapshot([assignment([['pay.vendor_bank_details', ['view', 'edit']]])]);
    const r = checkAssignmentSod({
      current,
      proposed: [assignment([['pay.batches', ['view', 'release']]])],
      justification: 'We really need this person to do both',
      ...opts([], FIRM),
    });
    expect(r.allowed).toBe(false);
    expect(r.blocked.map((c) => c.ruleKey)).toEqual(['S2']);
    expect(r.messages[0]).toMatch(/^Not allowed: Could change a vendor's bank details/);
  });

  it('an active allowed conflict lets the grant through — until it expires', () => {
    const now = new Date('2026-10-20T12:00:00Z');
    const ex = (expiresAt: string): SodException => ({
      id: 'ex-1', ruleId: S7.id, membershipId: 'm-1', locationId: L1, justification: 'Owner-run company',
      compensatingControl: null, approvedBy: 'u-admin', expiresAt, revokedAt: null,
    });
    const current = snapshot([assignment(VENDOR_MAKER)]);
    const live = checkAssignmentSod({ current, proposed: [assignment(PAYER)], ...opts([ex('2027-01-01T00:00:00Z')]), now });
    expect(live.allowed).toBe(true);
    expect(live.covered.map((c) => c.exceptionId)).toEqual(['ex-1']);
    const expired = checkAssignmentSod({ current, proposed: [assignment(PAYER)], ...opts([ex('2026-10-01T00:00:00Z')]), now });
    expect(expired.allowed).toBe(false);
    const revoked = checkAssignmentSod({
      current, proposed: [assignment(PAYER)], ...opts([{ ...ex('2027-01-01T00:00:00Z'), revokedAt: '2026-10-19T00:00:00Z' }]), now,
    });
    expect(revoked.allowed).toBe(false);
  });

  it('an exception for another client does not cover this one', () => {
    const ex: SodException = {
      id: 'ex-2', ruleId: S7.id, membershipId: 'm-1', locationId: L2, justification: 'Only on client two',
      compensatingControl: null, approvedBy: 'u-admin', expiresAt: '2999-01-01T00:00:00Z', revokedAt: null,
    };
    const r = checkAssignmentSod({ current: snapshot([assignment(VENDOR_MAKER)]), proposed: [assignment(PAYER)], ...opts([ex]) });
    expect(r.allowed).toBe(false);
  });

  it('pre-existing conflicts are reported, not re-blocked; txn_only never blocks', () => {
    const current = snapshot([assignment(VENDOR_MAKER), assignment(PAYER)]);
    const r = checkAssignmentSod({ current, proposed: [assignment([['reports.financial', ['view']]])], ...opts() });
    expect(r.allowed).toBe(true);
    expect(r.existing.map((c) => c.ruleKey)).toEqual(['S7']);
    const rec = checkAssignmentSod({
      current: snapshot([assignment([['bank.reconciliations', ['view', 'edit']]])]),
      proposed: [assignment([['bank.reconciliations', ['view', 'approve']]])],
      ...opts(),
    });
    expect(rec.allowed).toBe(true);
  });

  it('replacing an assignment by id evaluates the replacement, not both', () => {
    const payer = assignment(PAYER);
    const current = snapshot([assignment(VENDOR_MAKER), payer]);
    // replace the payer role with a muted version → the conflict disappears
    const r = checkAssignmentSod({ current, proposed: [{ ...payer, muted: { 'pay.batches': ['release'] } }], ...opts() });
    expect(r.allowed).toBe(true);
    expect(r.existing).toEqual([]);
  });
});

describe('assertActionSod — H6 transaction rules (platform-locked)', () => {
  it('preparer can never approve, release or sign off', () => {
    expect(checkActionSod({ actor: 'u1', action: 'approve', preparedBy: 'u1' })).toBe('PREPARER_CANNOT_APPROVE');
    expect(checkActionSod({ actor: 'u1', action: 'release', preparedBy: 'u1', soleApproverMode: true })).toBe('PREPARER_CANNOT_RELEASE');
    expect(checkActionSod({ actor: 'u1', action: 'sign_off', preparedBy: 'u1' })).toBe('PREPARER_CANNOT_SIGN_OFF');
    expect(checkActionSod({ actor: 'u2', action: 'approve', preparedBy: 'u1' })).toBeNull();
  });

  it('approver cannot release unless sole-approver mode', () => {
    expect(checkActionSod({ actor: 'u2', action: 'release', preparedBy: 'u1', approvedBy: 'u2' })).toBe('APPROVER_CANNOT_RELEASE');
    expect(checkActionSod({ actor: 'u2', action: 'release', preparedBy: 'u1', approvedBy: 'u2', soleApproverMode: true })).toBeNull();
    expect(checkActionSod({ actor: 'u3', action: 'release', preparedBy: 'u1', approvedBy: 'u2' })).toBeNull();
  });

  it('JE self-post: only at or above the threshold, never for system entries', () => {
    const base = { actor: 'u1', action: 'post' as const, preparedBy: 'u1', jeSelfPostThresholdCents: 2_500_000 };
    expect(checkActionSod({ ...base, amountCents: 2_499_999 })).toBeNull();
    expect(checkActionSod({ ...base, amountCents: 2_500_000 })).toBe('PREPARER_CANNOT_POST');
    expect(checkActionSod({ ...base, amountCents: 9_000_000, systemGenerated: true })).toBeNull();
    expect(checkActionSod({ actor: 'u1', action: 'post', preparedBy: 'u1' })).toBe('PREPARER_CANNOT_POST');
  });

  it('no releasing to a vendor whose bank details you changed in the last 10 days', () => {
    const now = new Date('2026-10-20T00:00:00Z');
    const input = { actor: 'u3', action: 'release' as const, preparedBy: 'u1', approvedBy: 'u2', now };
    expect(checkActionSod({ ...input, bankDetailChanges: [{ userId: 'u3', at: '2026-10-15T00:00:00Z' }] })).toBe('RECENT_BANK_DETAIL_CHANGE');
    expect(checkActionSod({ ...input, bankDetailChanges: [{ userId: 'u3', at: '2026-10-01T00:00:00Z' }] })).toBeNull();
    expect(checkActionSod({ ...input, bankDetailChanges: [{ userId: 'u9', at: '2026-10-19T00:00:00Z' }] })).toBeNull();
  });

  it('throws a plain-English error with an internal rule key', () => {
    try {
      assertActionSod({ actor: 'u2', action: 'release', preparedBy: 'u1', approvedBy: 'u2' });
      throw new Error('expected a violation');
    } catch (e) {
      expect(e).toBeInstanceOf(SodViolationError);
      const err = e as SodViolationError;
      expect(err.ruleKey).toBe('H6_APPROVER_RELEASER');
      expect(err.message).toBe('You approved this payment, so someone else has to release it.');
      expect(err.message).not.toMatch(/H6|S\d/);
    }
  });

  it('conflict messages never show rule codes', () => {
    expect(conflictMessage({ description: S7.description, enforcement: 'soft', suggestedFix: null }, 'Client One')).toBe(
      'Needs a reason on Client One: Could both create vendors and release payments to them, approving the bills in between.',
    );
  });
});

describe('dollar limits (05 §3.4)', () => {
  const limited = (cents: number) => ({ amount_limit: { max_per_item_cents: cents } });

  it('highest passing limit wins across stacked grants; unlimited beats any limit', () => {
    const snap = snapshot([
      assignment([['ap.bills', ['view', 'approve'], limited(2_500_000)]]),
      assignment([['ap.bills', ['view', 'approve'], limited(10_000_000)]], { scopeType: 'all_clients', locationId: null }),
    ]);
    expect(approvalLimitCheck(snap, 'ap.bills:approve', 5_000_000, { kind: 'client', locationId: L1 })).toEqual({
      allowed: true, limitCents: 10_000_000, held: true,
    });
    expect(withinApprovalLimit(snap, 'ap.bills:approve', 10_000_001, { kind: 'client', locationId: L1 })).toBe(false);
    // On L2 only the all-clients $100k grant applies
    expect(approvalLimitCheck(snap, 'ap.bills', 2_000_000, { kind: 'client', locationId: L2 }).limitCents).toBe(10_000_000);
    const unlimited = snapshot([assignment([['ap.bills', ['view', 'approve']]])]);
    expect(withinApprovalLimit(unlimited, 'ap.bills:approve', 999_999_999_99)).toBe(true);
  });

  it('assignment overrides only tighten', () => {
    const snap = snapshot([
      assignment([['ap.bills', ['view', 'approve'], limited(10_000_000)]], { constraintOverrides: limited(1_000_000) }),
    ]);
    expect(approvalLimitCheck(snap, 'ap.bills:approve', 0).limitCents).toBe(1_000_000);
    expect(withinApprovalLimit(snap, 'ap.bills:approve', 1_000_001)).toBe(false);
  });

  it('meetsApproverFloor: null floor = any holder; not held = never', () => {
    const snap = snapshot([assignment([['ap.bills', ['view', 'approve'], limited(2_500_000)]])]);
    expect(meetsApproverFloor(snap, 'ap.bills:approve', null)).toBe(true);
    expect(meetsApproverFloor(snap, 'ap.bills:approve', 2_500_000)).toBe(true);
    expect(meetsApproverFloor(snap, 'ap.bills:approve', 2_500_001)).toBe(false);
    expect(meetsApproverFloor(snap, 'pay.batches:approve', null)).toBe(false);
    expect(approvalLimitCheck(snap, 'not.a_cap:approve', 0)).toEqual({ allowed: false, limitCents: null, held: false });
  });
});

describe('approver-release limit (mig 174) — off / any / up to $X', () => {
  const base = { actor: 'u2', action: 'release' as const, preparedBy: 'u1', approvedBy: 'u2' };
  it('up to $X: at / below allowed, above / unknown refused', () => {
    const on = { ...base, soleApproverMode: true, soleApproverMaxCents: 500_000 };
    expect(checkActionSod({ ...on, amountCents: 500_000 })).toBeNull();
    expect(checkActionSod({ ...on, amountCents: 499_999 })).toBeNull();
    expect(checkActionSod({ ...on, amountCents: 500_001 })).toBe('APPROVER_OVER_RELEASE_LIMIT');
    expect(checkActionSod({ ...on, amountCents: -500_001 })).toBe('APPROVER_OVER_RELEASE_LIMIT');
    expect(checkActionSod({ ...on, amountCents: null })).toBe('APPROVER_OVER_RELEASE_LIMIT');
    expect(checkActionSod({ ...on })).toBe('APPROVER_OVER_RELEASE_LIMIT');
    // a second person is never limited
    expect(checkActionSod({ ...on, actor: 'u3', amountCents: 9_999_999 })).toBeNull();
  });
  it('any amount: no limit; off: a stored limit is ignored', () => {
    expect(checkActionSod({ ...base, soleApproverMode: true, soleApproverMaxCents: null, amountCents: 9_999_999 })).toBeNull();
    expect(checkActionSod({ ...base, soleApproverMode: false, soleApproverMaxCents: 500_000, amountCents: 1 })).toBe('APPROVER_CANNOT_RELEASE');
  });
  it('strict (payroll) refuses the approver whatever the setting; the preparer check comes first', () => {
    expect(checkActionSod({ ...base, soleApproverMode: true, strictApproverRelease: true, amountCents: 1 })).toBe('PAYROLL_APPROVER_CANNOT_RELEASE');
    expect(checkActionSod({ ...base, actor: 'u1', soleApproverMode: true, strictApproverRelease: true })).toBe('PREPARER_CANNOT_RELEASE');
  });
  it('every new code has plain-English text and maps to the approver rule', () => {
    for (const code of ['APPROVER_OVER_RELEASE_LIMIT', 'PAYROLL_APPROVER_CANNOT_RELEASE'] as const) {
      expect(ACTION_SOD_MESSAGE[code]).toMatch(/someone else has to release it/);
      expect(ACTION_SOD_RULE_KEY[code]).toBe('H6_APPROVER_RELEASER');
    }
  });
  it('loosening: off → on, up to → any, a higher limit; never the reverse', () => {
    const off = approverReleasePolicyOf(false, null);
    const any = approverReleasePolicyOf(true, null);
    const up5 = approverReleasePolicyOf(true, 500_000);
    const up9 = approverReleasePolicyOf(true, 900_000);
    expect(off).toEqual({ choice: 'off', maxCents: null });
    expect(approverReleasePolicyOf(false, 500_000)).toEqual({ choice: 'off', maxCents: null });
    expect(up5).toEqual({ choice: 'up_to', maxCents: 500_000 });
    expect(isApproverReleaseLoosening(off, any)).toBe(true);
    expect(isApproverReleaseLoosening(off, up5)).toBe(true);
    expect(isApproverReleaseLoosening(up5, up9)).toBe(true);
    expect(isApproverReleaseLoosening(up5, any)).toBe(true);
    expect(isApproverReleaseLoosening(up9, up5)).toBe(false);
    expect(isApproverReleaseLoosening(any, up9)).toBe(false);
    expect(isApproverReleaseLoosening(any, off)).toBe(false);
    expect(isApproverReleaseLoosening(up5, off)).toBe(false);
  });
});
