/**
 * Reconciliation close-gate guardrail (FPB Bank Reconciliation, Dimension 10).
 *
 * Proves the must-tie-to-close rule: a period may HARD_CLOSE only when every active
 * bank account has a finalized, tied ($0) reconciliation. Reconciled ⇒ pass;
 * missing / draft / non-zero-variance ⇒ blocked with a named reason.
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateReconciliationCloseGate,
  type BankAccountRecStatus,
} from './reconciliation-close-gate';

const acct = (over: Partial<BankAccountRecStatus>): BankAccountRecStatus => ({
  bankAccountId: 'ba1',
  accountName: 'Operating',
  hasReconciliation: true,
  isReconciled: true,
  differenceCents: 0,
  ...over,
});

describe('evaluateReconciliationCloseGate', () => {
  it('passes when there are no bank accounts to reconcile', () => {
    const r = evaluateReconciliationCloseGate([]);
    expect(r.pass).toBe(true);
    expect(r.blockers).toHaveLength(0);
    expect(r.accountsConsidered).toBe(0);
  });

  it('passes when every account is finalized and ties to $0', () => {
    const r = evaluateReconciliationCloseGate([
      acct({ bankAccountId: 'a', accountName: 'Operating' }),
      acct({ bankAccountId: 'b', accountName: 'Payroll' }),
    ]);
    expect(r.pass).toBe(true);
    expect(r.accountsReconciled).toBe(2);
  });

  it('blocks an account with no reconciliation', () => {
    const r = evaluateReconciliationCloseGate([
      acct({ hasReconciliation: false, isReconciled: false, differenceCents: null }),
    ]);
    expect(r.pass).toBe(false);
    expect(r.blockers[0].kind).toBe('unreconciled');
  });

  it('blocks a started-but-not-finalized reconciliation that already ties', () => {
    const r = evaluateReconciliationCloseGate([acct({ isReconciled: false, differenceCents: 0 })]);
    expect(r.pass).toBe(false);
    expect(r.blockers[0].kind).toBe('unreconciled');
  });

  it('blocks an unexplained variance (non-zero difference) — never a silent pass', () => {
    const r = evaluateReconciliationCloseGate([acct({ isReconciled: false, differenceCents: 4200 })]);
    expect(r.pass).toBe(false);
    expect(r.blockers[0].kind).toBe('unexplained_variance');
    expect(r.blockers[0].reason).toMatch(/variance/i);
  });

  it('defensively blocks a "reconciled" header that still carries a residual', () => {
    const r = evaluateReconciliationCloseGate([acct({ isReconciled: true, differenceCents: -100 })]);
    expect(r.pass).toBe(false);
    expect(r.blockers[0].kind).toBe('unexplained_variance');
  });

  it('reports each blocking account independently in a mixed set', () => {
    const r = evaluateReconciliationCloseGate([
      acct({ bankAccountId: 'ok', accountName: 'Operating' }),
      acct({ bankAccountId: 'miss', accountName: 'Savings', hasReconciliation: false, isReconciled: false, differenceCents: null }),
      acct({ bankAccountId: 'var', accountName: 'Payroll', isReconciled: false, differenceCents: 900 }),
    ]);
    expect(r.pass).toBe(false);
    expect(r.blockers).toHaveLength(2);
    expect(r.accountsReconciled).toBe(1);
    expect(r.blockers.map((b) => b.bankAccountId).sort()).toEqual(['miss', 'var']);
  });
});
