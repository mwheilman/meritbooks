/**
 * The "WIP: review proposed accrual" close task (FPB-rev-rec-wip §5, AC 6): a proposed or
 * not-yet-run WIP entry blocks hard close; posted / no-change / dismissed-with-reason / not
 * applicable passes.
 */

import { describe, it, expect } from 'vitest';
import {
  CLOSE_TASK_GRAPH,
  MANUAL_TASK_KEYS,
  evaluateCloseGraph,
  evaluateHardCloseGate,
  getCloseTask,
  type CloseSignals,
  type CloseTaskKey,
  type WipCloseSignal,
} from './orchestration';

const CLEAN: CloseSignals = {
  uncodedBankCents: 0, reconciliationBlockers: 0, arVarianceCents: 0, apVarianceCents: 0,
  blockingLeakageCents: 0, leakageItems: 0, openExceptions: 0, unpostedDraftCount: 0,
  billsOnHoldCount: 0, unappliedPaymentCount: 0, unappliedPaymentCents: 0, pendingApprovalCount: 0,
};
const ALL_MANUAL = new Set<CloseTaskKey>(MANUAL_TASK_KEYS);

const wip = (over: Partial<WipCloseSignal>): WipCloseSignal => ({
  applicable: true, status: 'PROPOSED', jobs: 14, underbilledCents: 21_200_000, overbilledCents: 8_800_000,
  lossProvisionCents: 0, dismissReason: null, reversalPending: false, ...over,
});

function evalWith(w: WipCloseSignal | null | undefined) {
  const ev = evaluateCloseGraph({ ...CLEAN, wipAccrual: w }, ALL_MANUAL);
  return { ev, task: ev.tasks.find((t) => t.key === 'wip_accrual_reviewed')!, gate: evaluateHardCloseGate(ev, null) };
}

describe('wip_accrual_reviewed close task', () => {
  it('is a blocking AUTO task after the AR/AP tie and before the final review', () => {
    const t = getCloseTask('wip_accrual_reviewed');
    expect(t).toMatchObject({ kind: 'AUTO', blocking: true, phase: 'FINAL', deepLinkHref: '/jobs/wip' });
    expect(t.dependsOn).toEqual(['ar_subledger_tie', 'ap_subledger_tie']);
    expect(getCloseTask('reviewed').dependsOn).toContain('wip_accrual_reviewed');
    const idx = (k: CloseTaskKey) => CLOSE_TASK_GRAPH.findIndex((x) => x.key === k);
    expect(idx('wip_accrual_reviewed')).toBeLessThan(idx('reviewed'));
  });

  it('a PROPOSED entry blocks hard close with the WIP summary', () => {
    const { ev, task, gate } = evalWith(wip({}));
    expect(task.status).toBe('blocked');
    expect(task.reason).toBe('WIP: 14 job(s), underbilled $212,000.00, overbilled $88,000.00 → proposed entry awaiting approval');
    expect(ev.readyToHardClose).toBe(false);
    expect(gate.pass).toBe(false);
    expect(gate.blockers.map((b) => b.key)).toContain('wip_accrual_reviewed');
  });

  it('not run yet, failed, or unknown also blocks', () => {
    for (const status of ['NOT_RUN', 'FAILED', 'UNKNOWN'] as const) {
      expect(evalWith(wip({ status })).ev.readyToHardClose, status).toBe(false);
    }
  });

  it('posted, no-change and dismissed-with-reason pass', () => {
    expect(evalWith(wip({ status: 'POSTED' })).task.status).toBe('pass');
    expect(evalWith(wip({ status: 'POSTED', reversalPending: true })).task.driverLabel).toMatch(/reversal pending/);
    expect(evalWith(wip({ status: 'NO_CHANGE' })).task.status).toBe('pass');
    const dismissed = evalWith(wip({ status: 'DISMISSED', dismissReason: 'Jobs are T&M this month' }));
    expect(dismissed.task.status).toBe('pass');
    expect(dismissed.task.driverLabel).toBe('Dismissed: Jobs are T&M this month');
    expect(dismissed.ev.readyToHardClose).toBe(true);
  });

  it('not applicable (no WIP jobs / switches off / no signal) passes', () => {
    expect(evalWith(wip({ applicable: false, status: 'NOT_RUN' })).task.status).toBe('pass');
    expect(evalWith(undefined).task.status).toBe('pass');
    expect(evalWith(null).ev.readyToHardClose).toBe(true);
  });

  it('an authorized override still lets a blocked close through (audited by the caller)', () => {
    const { ev } = evalWith(wip({}));
    expect(evaluateHardCloseGate(ev, 'Controller approved — WIP booked offline').pass).toBe(true);
  });
});
