import { describe, it, expect } from 'vitest';
import {
  applicableSteps,
  advanceChain,
  roleMeetsStep,
  validateWorkflowSteps,
  firstStepOrder,
  WorkflowError,
  type WorkflowStepDef,
  type ChainState,
  type WorkflowDef,
} from './workflow';

// A 3-tier chain: manager on everything, controller at $10k+, CFO at $50k+.
const STEPS: WorkflowStepDef[] = [
  { stepOrder: 1, minAmountCents: 0, maxAmountCents: null, approverRole: 'accounting_manager', requireDistinct: true },
  { stepOrder: 2, minAmountCents: 10_000_00, maxAmountCents: null, approverRole: 'merit_controller', requireDistinct: true },
  { stepOrder: 3, minAmountCents: 50_000_00, maxAmountCents: null, approverRole: 'cfo', requireDistinct: true },
];

const wf: WorkflowDef = { id: 'wf1', docType: 'BILL', name: 'AP chain', active: true, steps: STEPS };

function state(over: Partial<ChainState> = {}): ChainState {
  const steps = over.steps ?? applicableSteps(wf, 60_000_00);
  return {
    steps,
    currentStep: over.currentStep ?? firstStepOrder(steps)!,
    status: over.status ?? 'PENDING',
    preparedBy: over.preparedBy ?? 'preparer',
    actions: over.actions ?? [],
  };
}

describe('applicableSteps — amount-tier resolution', () => {
  it('selects only step 1 for a small amount', () => {
    const steps = applicableSteps(wf, 5_000_00);
    expect(steps.map((s) => s.stepOrder)).toEqual([1]);
  });

  it('selects steps 1 and 2 for a mid amount', () => {
    const steps = applicableSteps(wf, 25_000_00);
    expect(steps.map((s) => s.stepOrder)).toEqual([1, 2]);
  });

  it('selects all three for a large amount', () => {
    const steps = applicableSteps(wf, 60_000_00);
    expect(steps.map((s) => s.stepOrder)).toEqual([1, 2, 3]);
  });

  it('respects an upper band boundary', () => {
    const banded: WorkflowDef = {
      ...wf,
      steps: [
        { stepOrder: 1, minAmountCents: 0, maxAmountCents: 100_00, approverRole: 'general_admin', requireDistinct: false },
        { stepOrder: 2, minAmountCents: 100_01, maxAmountCents: null, approverRole: 'cfo', requireDistinct: false },
      ],
    };
    expect(applicableSteps(banded, 100_00).map((s) => s.stepOrder)).toEqual([1]);
    expect(applicableSteps(banded, 100_01).map((s) => s.stepOrder)).toEqual([2]);
  });

  it('returns empty when no band covers the amount (degrade-safe)', () => {
    const banded: WorkflowDef = {
      ...wf,
      steps: [{ stepOrder: 1, minAmountCents: 1_000_00, maxAmountCents: null, approverRole: 'cfo', requireDistinct: false }],
    };
    expect(applicableSteps(banded, 500_00)).toEqual([]);
  });
});

describe('roleMeetsStep — authority ranking', () => {
  it('a higher role satisfies a lower requirement', () => {
    expect(roleMeetsStep('cfo', 'accounting_manager')).toBe(true);
  });
  it('an exact role satisfies its own requirement', () => {
    expect(roleMeetsStep('merit_controller', 'merit_controller')).toBe(true);
  });
  it('a lower role does NOT satisfy a higher requirement', () => {
    expect(roleMeetsStep('accounting_manager', 'cfo')).toBe(false);
  });
  it('a null role never satisfies', () => {
    expect(roleMeetsStep(null, 'general_admin')).toBe(false);
  });
});

describe('advanceChain — completion across tiers', () => {
  it('advances through each step and completes only at the last', () => {
    let s = state(); // 3-step chain, $60k
    const r1 = advanceChain(s, { userId: 'mgr', role: 'accounting_manager' }, 'APPROVE');
    expect(r1.status).toBe('PENDING');
    expect(r1.currentStep).toBe(2);
    expect(r1.approvedComplete).toBe(false);

    s = { ...s, currentStep: 2, actions: [{ stepOrder: 1, actorUser: 'mgr', decision: 'APPROVE' }] };
    const r2 = advanceChain(s, { userId: 'ctrl', role: 'merit_controller' }, 'APPROVE');
    expect(r2.currentStep).toBe(3);
    expect(r2.approvedComplete).toBe(false);

    s = {
      ...s,
      currentStep: 3,
      actions: [
        { stepOrder: 1, actorUser: 'mgr', decision: 'APPROVE' },
        { stepOrder: 2, actorUser: 'ctrl', decision: 'APPROVE' },
      ],
    };
    const r3 = advanceChain(s, { userId: 'cfo', role: 'cfo' }, 'APPROVE');
    expect(r3.status).toBe('APPROVED');
    expect(r3.completed).toBe(true);
    expect(r3.approvedComplete).toBe(true);
  });

  it('a single-step chain completes on the first approval', () => {
    const steps = applicableSteps(wf, 5_000_00); // only step 1
    const s = state({ steps, currentStep: 1 });
    const r = advanceChain(s, { userId: 'mgr', role: 'accounting_manager' }, 'APPROVE');
    expect(r.approvedComplete).toBe(true);
    expect(r.status).toBe('APPROVED');
  });

  it('rejects terminate the chain immediately', () => {
    const s = state();
    const r = advanceChain(s, { userId: 'mgr', role: 'accounting_manager' }, 'REJECT');
    expect(r.status).toBe('REJECTED');
    expect(r.completed).toBe(true);
    expect(r.approvedComplete).toBe(false);
  });
});

describe('advanceChain — separation of duties + distinct approver', () => {
  it('preparer can never act on their own document', () => {
    const s = state({ preparedBy: 'mgr' });
    expect(() => advanceChain(s, { userId: 'mgr', role: 'accounting_manager' }, 'APPROVE')).toThrow(WorkflowError);
    try {
      advanceChain(s, { userId: 'mgr', role: 'accounting_manager' }, 'APPROVE');
    } catch (e) {
      expect((e as WorkflowError).code).toBe('PREPARER_CANNOT_APPROVE');
    }
  });

  it('a require_distinct step rejects an approver who approved an earlier step', () => {
    const s = state({
      currentStep: 2,
      actions: [{ stepOrder: 1, actorUser: 'dave', decision: 'APPROVE' }],
    });
    // dave has controller authority but already approved step 1 → distinct required.
    try {
      advanceChain(s, { userId: 'dave', role: 'merit_controller' }, 'APPROVE');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(WorkflowError);
      expect((e as WorkflowError).code).toBe('DISTINCT_APPROVER_REQUIRED');
    }
  });

  it('a different distinct approver at step 2 is allowed', () => {
    const s = state({
      currentStep: 2,
      actions: [{ stepOrder: 1, actorUser: 'mgr', decision: 'APPROVE' }],
    });
    const r = advanceChain(s, { userId: 'ctrl', role: 'merit_controller' }, 'APPROVE');
    expect(r.currentStep).toBe(3);
  });

  it('a non-distinct step permits the same approver to act again', () => {
    const steps: WorkflowStepDef[] = [
      { stepOrder: 1, minAmountCents: 0, maxAmountCents: null, approverRole: 'accounting_manager', requireDistinct: false },
      { stepOrder: 2, minAmountCents: 0, maxAmountCents: null, approverRole: 'accounting_manager', requireDistinct: false },
    ];
    const s: ChainState = {
      steps,
      currentStep: 2,
      status: 'PENDING',
      preparedBy: 'preparer',
      actions: [{ stepOrder: 1, actorUser: 'sam', decision: 'APPROVE' }],
    };
    const r = advanceChain(s, { userId: 'sam', role: 'accounting_manager' }, 'APPROVE');
    expect(r.status).toBe('APPROVED');
  });
});

describe('advanceChain — role and state guards', () => {
  it('rejects an under-authorized approver at a step', () => {
    const s = state({ currentStep: 3 });
    try {
      advanceChain(s, { userId: 'mgr', role: 'accounting_manager' }, 'APPROVE');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as WorkflowError).code).toBe('ROLE_NOT_AUTHORIZED');
    }
  });

  it('refuses to act on a non-pending request', () => {
    const s = state({ status: 'APPROVED' });
    try {
      advanceChain(s, { userId: 'cfo', role: 'cfo' }, 'APPROVE');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as WorkflowError).code).toBe('NOT_PENDING');
    }
  });
});

describe('validateWorkflowSteps', () => {
  it('accepts a well-formed chain', () => {
    expect(validateWorkflowSteps(STEPS)).toEqual([]);
  });
  it('rejects an empty chain', () => {
    expect(validateWorkflowSteps([]).length).toBe(1);
  });
  it('flags duplicate step orders and inverted bands', () => {
    const bad: WorkflowStepDef[] = [
      { stepOrder: 1, minAmountCents: 0, maxAmountCents: null, approverRole: 'cfo', requireDistinct: false },
      { stepOrder: 1, minAmountCents: 500, maxAmountCents: 100, approverRole: 'cfo', requireDistinct: false },
    ];
    const errs = validateWorkflowSteps(bad);
    expect(errs.some((e) => e.includes('Duplicate step order'))).toBe(true);
    expect(errs.some((e) => e.includes('below the minimum'))).toBe(true);
  });
});
