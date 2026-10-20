/**
 * Approval workflows on capability (05 R-12 / §3.4): a step with approver_role null
 * routes on approver_capability + min_approver_limit_cents; a step with a role keeps the
 * legacy role-rank routing exactly (compat for pre-165 / backfilled steps).
 */

import { describe, it, expect } from 'vitest';
import {
  advanceChain,
  actorMeetsStep,
  isCapabilityStep,
  validateWorkflowSteps,
  WorkflowError,
  type Actor,
  type ChainState,
  type WorkflowStepDef,
} from './workflow';
import { detectCoverageGaps } from './analysis';
import { stepApproverLabel } from './step-label';
import type { AccessSnapshot } from '@/lib/rbac/effective-access';
import { meetsApproverFloor } from '@/lib/rbac/limits';

const capStep = (order: number, floor: number | null, cap = 'ap.bills:approve'): WorkflowStepDef => ({
  stepOrder: order,
  minAmountCents: 0,
  maxAmountCents: null,
  approverRole: null,
  approverCapability: cap,
  minApproverLimitCents: floor,
  requireDistinct: true,
});

/** An approver whose effective access holds ap.bills:approve up to `limit` (null = unlimited). */
function approverWithLimit(userId: string, limit: number | null): Actor {
  const snap: AccessSnapshot = {
    membership: { id: `m-${userId}`, orgId: 'o', status: 'active', audience: 'internal_staff', accessEpoch: 0 },
    assignments: [
      {
        id: `a-${userId}`,
        grantType: 'role',
        source: { id: 'r', key: 'r', name: 'R', ownerLevel: 'tenant', locationId: null, audience: 'internal_staff', version: 1 },
        grants: [{ capability: 'ap.bills', actions: ['view', 'approve'], constraints: limit === null ? {} : { amount_limit: { max_per_item_cents: limit } } }],
        scopeType: 'all_clients', locationId: null, clientSetId: null, clientSetLocationIds: [], groupId: null,
        readOnly: false, muted: {}, constraintOverrides: {}, effectiveFrom: null, effectiveTo: null, status: 'active',
      },
    ],
    envelopes: {},
  };
  return { userId, role: null, capabilityCheck: (cap, floor) => meetsApproverFloor(snap, cap, floor, { kind: 'client', locationId: 'L1' }) };
}

function state(steps: WorkflowStepDef[], currentStep = 1, actions: ChainState['actions'] = []): ChainState {
  return { steps, currentStep, status: 'PENDING', preparedBy: 'preparer', actions };
}

describe('capability-routed steps', () => {
  it('a manager ($25k limit) clears a $0-floor step but not a $50k-floor step; the CFO (unlimited) clears both', () => {
    const steps = [capStep(1, null), capStep(2, 5_000_000)];
    const manager = approverWithLimit('mgr', 2_500_000);
    const cfo = approverWithLimit('cfo', null);

    const r1 = advanceChain(state(steps), manager, 'APPROVE');
    expect(r1).toMatchObject({ status: 'PENDING', currentStep: 2 });

    expect(() => advanceChain(state(steps, 2, [{ stepOrder: 1, actorUser: 'mgr', decision: 'APPROVE' }]), manager, 'APPROVE')).toThrowError(
      WorkflowError,
    );
    try {
      advanceChain(state(steps, 2), manager, 'APPROVE');
    } catch (e) {
      expect((e as WorkflowError).code).toBe('CAPABILITY_NOT_AUTHORIZED');
      expect((e as WorkflowError).message).toBe('This step needs someone who can approve at least $50,000');
    }
    const r2 = advanceChain(state(steps, 2, [{ stepOrder: 1, actorUser: 'mgr', decision: 'APPROVE' }]), cfo, 'APPROVE');
    expect(r2).toMatchObject({ status: 'APPROVED', approvedComplete: true });
  });

  it('a person without the capability (or with no checker) is refused; preparer is refused first', () => {
    const step = capStep(1, null);
    expect(actorMeetsStep({ userId: 'x', role: 'cfo' }, step)).toBe(false); // role alone never satisfies a capability step
    const holder = approverWithLimit('preparer', null);
    try {
      advanceChain(state([step]), holder, 'APPROVE');
    } catch (e) {
      expect((e as WorkflowError).code).toBe('PREPARER_CANNOT_APPROVE');
    }
    const wrongCap = capStep(1, null, 'pay.batches:approve');
    expect(actorMeetsStep(approverWithLimit('a', null), wrongCap)).toBe(false);
  });

  it('a step with a role keeps legacy role-rank routing even when a capability is backfilled', () => {
    const backfilled: WorkflowStepDef = { ...capStep(1, null), approverRole: 'merit_controller' };
    expect(isCapabilityStep(backfilled)).toBe(false);
    expect(actorMeetsStep({ userId: 'u', role: 'cfo' }, backfilled)).toBe(true);
    expect(actorMeetsStep({ userId: 'u', role: 'accounting_manager' }, backfilled)).toBe(false);
    // the capability checker is NOT consulted for a role step
    expect(actorMeetsStep({ userId: 'u', role: 'accounting_manager', capabilityCheck: () => true }, backfilled)).toBe(false);
  });

  it('validator: a step needs a role or an approval permission; floor must be non-negative', () => {
    expect(validateWorkflowSteps([capStep(1, 100_000_00)])).toEqual([]);
    expect(validateWorkflowSteps([{ ...capStep(1, null), approverCapability: null }])[0]).toMatch(/choose who can approve/);
    expect(validateWorkflowSteps([capStep(1, null, 'ap.bills:view')])[0]).toMatch(/not an approval permission/);
    expect(validateWorkflowSteps([capStep(1, null, 'nope.nothing:approve')])[0]).toMatch(/not an approval permission/);
    expect(validateWorkflowSteps([capStep(1, -1)])[0]).toMatch(/minimum limit/);
  });

  it('labels are plain English; coverage flags an invalid capability', () => {
    expect(stepApproverLabel(capStep(1, null))).toBe('Anyone who can approve bills');
    expect(stepApproverLabel(capStep(1, 1_000_000))).toBe('Anyone who can approve bills, with a limit of at least $10,000.00');
    expect(stepApproverLabel({ approverRole: 'cfo', approverCapability: 'ap.bills:approve' })).toBe('CFO');
    const findings = detectCoverageGaps(
      [{ id: 'w', docType: 'BILL', name: 'AP', active: true, steps: [capStep(1, null, 'broken')] }],
      { docTypes: ['BILL'] },
    );
    expect(findings.map((f) => f.code)).toEqual(['UNKNOWN_CAPABILITY']);
  });
});
