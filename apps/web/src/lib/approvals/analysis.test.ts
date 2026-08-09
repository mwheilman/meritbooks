import { describe, it, expect } from 'vitest';
import {
  simulateChain,
  bandCoverageGaps,
  detectCoverageGaps,
  roleIsSatisfiable,
  isKnownRole,
  type AnalyzableWorkflow,
} from './analysis';
import type { WorkflowStepDef } from './workflow';

// A 3-tier BILL chain: manager on everything, controller at $10k+, CFO at $50k+.
const BILL_STEPS: WorkflowStepDef[] = [
  { stepOrder: 1, minAmountCents: 0, maxAmountCents: null, approverRole: 'accounting_manager', requireDistinct: true },
  { stepOrder: 2, minAmountCents: 10_000_00, maxAmountCents: null, approverRole: 'merit_controller', requireDistinct: true },
  { stepOrder: 3, minAmountCents: 50_000_00, maxAmountCents: null, approverRole: 'cfo', requireDistinct: true },
];

const workflows: AnalyzableWorkflow[] = [
  { id: 'wf-bill', docType: 'BILL', name: 'AP chain', active: true, steps: BILL_STEPS },
  // A draft (inactive) PAYMENT chain — must be ignored by resolution.
  {
    id: 'wf-pay-draft',
    docType: 'PAYMENT',
    name: 'Payment draft',
    active: false,
    steps: [{ stepOrder: 1, minAmountCents: 0, maxAmountCents: null, approverRole: 'cfo', requireDistinct: true }],
  },
];

describe('simulateChain — deterministic scenario resolution', () => {
  it('returns the ordered approver sequence for the matching tier', () => {
    const out = simulateChain(workflows, 'BILL', 60_000_00);
    expect(out.kind).toBe('CHAIN');
    if (out.kind === 'CHAIN') {
      expect(out.workflowId).toBe('wf-bill');
      expect(out.sequence.map((s) => s.approverRole)).toEqual([
        'accounting_manager',
        'merit_controller',
        'cfo',
      ]);
    }
  });

  it('selects only the low tier for a small amount', () => {
    const out = simulateChain(workflows, 'BILL', 5_000_00);
    expect(out.kind).toBe('CHAIN');
    if (out.kind === 'CHAIN') expect(out.sequence.map((s) => s.stepOrder)).toEqual([1]);
  });

  it('reports NO_ACTIVE_WORKFLOW when no active chain exists (draft ignored)', () => {
    expect(simulateChain(workflows, 'PAYMENT', 100_00).kind).toBe('NO_ACTIVE_WORKFLOW');
    expect(simulateChain(workflows, 'PAYROLL', 100_00).kind).toBe('NO_ACTIVE_WORKFLOW');
  });

  it('reports NO_APPLICABLE_STEPS when a chain exists but no band covers the amount', () => {
    const gapped: AnalyzableWorkflow[] = [
      {
        id: 'x',
        docType: 'EXPENSE',
        name: 'Expense',
        active: true,
        steps: [{ stepOrder: 1, minAmountCents: 1_000_00, maxAmountCents: null, approverRole: 'cfo', requireDistinct: false }],
      },
    ];
    expect(simulateChain(gapped, 'EXPENSE', 500_00).kind).toBe('NO_APPLICABLE_STEPS');
  });
});

describe('bandCoverageGaps — complement over [0, ∞)', () => {
  it('returns no gaps when a $0+ step covers everything', () => {
    expect(bandCoverageGaps(BILL_STEPS)).toEqual([]);
  });

  it('reports the [0, min) gap when the lowest step starts above zero', () => {
    const steps: WorkflowStepDef[] = [
      { stepOrder: 1, minAmountCents: 100_00, maxAmountCents: null, approverRole: 'cfo', requireDistinct: false },
    ];
    expect(bandCoverageGaps(steps)).toEqual([{ fromCents: 0, toCents: 100_00 - 1 }]);
  });

  it('reports an interior hole between two capped bands', () => {
    const steps: WorkflowStepDef[] = [
      { stepOrder: 1, minAmountCents: 0, maxAmountCents: 100_00, approverRole: 'general_admin', requireDistinct: false },
      { stepOrder: 2, minAmountCents: 200_00, maxAmountCents: null, approverRole: 'cfo', requireDistinct: false },
    ];
    // Hole is $100.01 .. $199.99, i.e. 100_01 .. 199_99.
    expect(bandCoverageGaps(steps)).toEqual([{ fromCents: 100_00 + 1, toCents: 200_00 - 1 }]);
  });

  it('treats an empty chain as fully uncovered', () => {
    expect(bandCoverageGaps([])).toEqual([{ fromCents: 0, toCents: null }]);
  });
});

describe('roleIsSatisfiable — active-member authority', () => {
  it('is satisfied when a higher-ranked active member exists', () => {
    // Only a cfo is active; a step requiring accounting_manager is still satisfiable.
    expect(roleIsSatisfiable('accounting_manager', { cfo: 1 })).toBe(true);
  });
  it('is NOT satisfied when only lower-ranked members are active', () => {
    expect(roleIsSatisfiable('cfo', { accounting_manager: 3 })).toBe(false);
  });
  it('is NOT satisfied when nobody is active', () => {
    expect(roleIsSatisfiable('accounting_manager', {})).toBe(false);
  });
});

describe('isKnownRole', () => {
  it('accepts a catalog role and rejects drift', () => {
    expect(isKnownRole('cfo')).toBe(true);
    expect(isKnownRole('grand_poobah')).toBe(false);
  });
});

describe('detectCoverageGaps', () => {
  it('flags doc types with no active chain', () => {
    const findings = detectCoverageGaps(workflows);
    const noRule = findings.filter((f) => f.code === 'NO_ACTIVE_WORKFLOW').map((f) => f.docType);
    // BILL has an active chain; the other four do not (PAYMENT only has a draft).
    expect(noRule).toContain('PAYMENT');
    expect(noRule).toContain('PAYROLL');
    expect(noRule).toContain('JOURNAL_ENTRY');
    expect(noRule).toContain('EXPENSE');
    expect(noRule).not.toContain('BILL');
  });

  it('flags an amount band gap under an above-zero first step', () => {
    const wf: AnalyzableWorkflow[] = [
      {
        id: 'j',
        docType: 'JOURNAL_ENTRY',
        name: 'JE',
        active: true,
        steps: [{ stepOrder: 1, minAmountCents: 500_00, maxAmountCents: null, approverRole: 'cfo', requireDistinct: false }],
      },
    ];
    const gap = detectCoverageGaps(wf, { docTypes: ['JOURNAL_ENTRY'] }).find((f) => f.code === 'AMOUNT_BAND_GAP');
    expect(gap).toBeDefined();
    expect(gap?.bandFromCents).toBe(0);
    expect(gap?.bandToCents).toBe(500_00 - 1);
  });

  it('flags an unknown role as critical', () => {
    const wf: AnalyzableWorkflow[] = [
      {
        id: 'p',
        docType: 'PAYROLL',
        name: 'Payroll',
        active: true,
        steps: [{ stepOrder: 1, minAmountCents: 0, maxAmountCents: null, approverRole: 'wizard' as never, requireDistinct: false }],
      },
    ];
    const finding = detectCoverageGaps(wf, { docTypes: ['PAYROLL'] }).find((f) => f.code === 'UNKNOWN_ROLE');
    expect(finding?.severity).toBe('critical');
    expect(finding?.role).toBe('wizard');
  });

  it('flags an unsatisfiable role when no active member can approve it', () => {
    const wf: AnalyzableWorkflow[] = [
      {
        id: 'e',
        docType: 'EXPENSE',
        name: 'Expense',
        active: true,
        steps: [{ stepOrder: 1, minAmountCents: 0, maxAmountCents: null, approverRole: 'cfo', requireDistinct: false }],
      },
    ];
    // Only lower-ranked specialists are active → the cfo step is a dead step.
    const finding = detectCoverageGaps(wf, {
      docTypes: ['EXPENSE'],
      activeRoleCounts: { accounting_specialist: 2 },
    }).find((f) => f.code === 'UNSATISFIABLE_ROLE');
    expect(finding?.severity).toBe('critical');
    expect(finding?.stepOrder).toBe(1);
  });

  it('does NOT flag unsatisfiable when a higher-ranked member is active', () => {
    const wf: AnalyzableWorkflow[] = [
      {
        id: 'e',
        docType: 'EXPENSE',
        name: 'Expense',
        active: true,
        steps: [{ stepOrder: 1, minAmountCents: 0, maxAmountCents: null, approverRole: 'accounting_manager', requireDistinct: false }],
      },
    ];
    const findings = detectCoverageGaps(wf, {
      docTypes: ['EXPENSE'],
      activeRoleCounts: { cfo: 1 },
    });
    expect(findings.some((f) => f.code === 'UNSATISFIABLE_ROLE')).toBe(false);
  });
});
