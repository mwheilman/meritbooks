/**
 * The "Flux review" close task (FPB-financial-reports §5 A-3E.4, AC-3E.5): an open flux
 * review blocks HARD_CLOSE; complete / waived / not required / nothing material passes;
 * UNKNOWN fails closed; the whole-gate override still works and names the flux blocker.
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
} from './orchestration';
import { FLUX_SIGNAL_UNKNOWN } from './flux/gate';
import type { FluxCloseSignal } from './flux/types';

const CLEAN: CloseSignals = {
  uncodedBankCents: 0, reconciliationBlockers: 0, arVarianceCents: 0, apVarianceCents: 0,
  blockingLeakageCents: 0, leakageItems: 0, openExceptions: 0, unpostedDraftCount: 0,
  billsOnHoldCount: 0, unappliedPaymentCount: 0, unappliedPaymentCents: 0, pendingApprovalCount: 0,
};
const ALL_MANUAL = new Set<CloseTaskKey>(MANUAL_TASK_KEYS);
const F = (over: Partial<FluxCloseSignal>): FluxCloseSignal => ({
  applicable: true, status: 'OPEN', material: 4, explained: 1, reviewed: 1, stale: 1, unexplained: 1, waiverReason: null, ...over,
});
const run = (flux: FluxCloseSignal | null | undefined, reason: string | null = null) => {
  const ev = evaluateCloseGraph({ ...CLEAN, flux }, ALL_MANUAL);
  return { ev, task: ev.tasks.find((t) => t.key === 'flux_reviewed')!, gate: evaluateHardCloseGate(ev, reason) };
};

describe('flux_reviewed close task', () => {
  it('is a blocking AUTO task after accruals / prepaids / depreciation / WIP, before the final review', () => {
    const t = getCloseTask('flux_reviewed');
    expect(t).toMatchObject({ kind: 'AUTO', blocking: true, phase: 'FINAL', deepLinkHref: '/close?tab=flux' });
    expect(t.dependsOn).toEqual(['accruals_posted', 'prepaids_posted', 'depreciation_posted', 'wip_accrual_reviewed']);
    expect(getCloseTask('reviewed').dependsOn).toContain('flux_reviewed');
    const idx = (k: CloseTaskKey) => CLOSE_TASK_GRAPH.findIndex((x) => x.key === k);
    expect(idx('flux_reviewed')).toBeLessThan(idx('reviewed'));
    expect(new Set(CLOSE_TASK_GRAPH.map((x) => x.order)).size).toBe(CLOSE_TASK_GRAPH.length);
  });

  it('an open review blocks the hard close and says what is open', () => {
    const { ev, task, gate } = run(F({}));
    expect(task.status).toBe('blocked');
    expect(task.driverLabel).toBe('3 of 4 open');
    expect(task.reason).toBe('Flux: 4 material change(s) — 1 unexplained, 1 awaiting review, 1 changed since explained');
    expect(ev.readyToHardClose).toBe(false);
    expect(gate.pass).toBe(false);
    expect(gate.blockers.map((b) => b.key)).toEqual(['flux_reviewed']);
  });

  it('UNKNOWN fails closed', () => {
    expect(run(FLUX_SIGNAL_UNKNOWN).gate.pass).toBe(false);
  });

  it('complete, waived, not required, nothing material, or absent all pass', () => {
    for (const s of [
      F({ status: 'COMPLETE', reviewed: 4, explained: 0, stale: 0, unexplained: 0 }),
      F({ status: 'WAIVED', waiverReason: 'Interim close for the lender' }),
      F({ status: 'NOT_REQUIRED', applicable: false }),
      F({ status: 'NOTHING_MATERIAL', material: 0 }),
      null,
      undefined,
    ]) {
      const { ev, gate } = run(s);
      expect(ev.readyToHardClose, String(s?.status)).toBe(true);
      expect(gate.pass).toBe(true);
    }
    expect(run(F({ status: 'WAIVED', waiverReason: 'Interim close for the lender' })).task.driverLabel).toBe('Waived: Interim close for the lender');
  });

  it('the whole-gate override still lets an authorized user force the close, naming the flux blocker', () => {
    const { gate } = run(F({}), 'Lender deadline — flux follows Monday');
    expect(gate).toMatchObject({ pass: true, overridden: true });
    expect(gate.blockers[0].key).toBe('flux_reviewed');
  });
});
